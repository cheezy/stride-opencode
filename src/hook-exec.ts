import type { HookName } from "./parser";

// --- Hook execution with per-hook time budgets (W1495) ---
//
// Mirrors the canonical bash hook (stride-hook.sh run_stride_section /
// run_with_budget, W1454): each section gets a fixed budget, every command
// runs under the budget REMAINING for the section, expiry group-kills the
// command's whole process tree (TERM → grace → KILL), and a timeout reports
// exit code 124 (the GNU timeout convention) plus timed_out/budget fields on
// the failure JSON.

/** Canonical per-hook budgets from the stride-workflow Hooks Reference. */
export const HOOK_TIMEOUTS_MS: Readonly<Record<HookName, number>> = {
  before_doing: 60_000,
  after_doing: 120_000,
  before_review: 60_000,
  after_review: 60_000,
  after_goal: 60_000,
};

/** TERM → KILL grace period, mirroring the bash watchdog. */
export const KILL_GRACE_MS = 2_000;

/** GNU timeout convention, shared with stride-hook.sh (W1454). */
export const TIMEOUT_EXIT_CODE = 124;

export function resolveHookTimeoutMs(
  hookName: HookName,
  overrides?: Partial<Record<HookName, number>>,
): number {
  return overrides?.[hookName] ?? HOOK_TIMEOUTS_MS[hookName];
}

export interface CommandOutput {
  command: string;
  stdout: string;
  stderr: string;
}

export interface HookResult {
  hook: HookName;
  status: "success" | "failed" | "skipped";
  commands_completed: string[];
  // (D65) Per-command tail-truncated output on the success path. Folded into the
  // success JSON instead of being written to process.stderr, so a passing gate
  // is never rendered as a hook error by a host that treats stderr as failure.
  commands_output?: CommandOutput[];
  commands_remaining?: string[];
  failed_command?: string;
  command_index?: number;
  exit_code?: number;
  // (W1495) Present on every failed result — mirrors the bash hook's
  // timed_out/budget_seconds failure fields (in ms, like duration_ms).
  timed_out?: boolean;
  budget_ms?: number;
  stdout?: string;
  stderr?: string;
  duration_ms: number;
}

export interface ExecOptions {
  cwd: string;
  env: Record<string, string>;
  /** Section-level budget shared by the whole command list. */
  budgetMs: number;
  /** TERM → KILL grace; injectable so tests run in milliseconds. */
  killGraceMs?: number;
  /** Clock override, skill-gate DI style. */
  now?: () => number;
}

interface CommandRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

async function runCommandWithBudget(
  cmd: string,
  opts: {
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
    killGraceMs: number;
  },
): Promise<CommandRunResult> {
  // detached puts sh in its own process group (setsid), so the group kill
  // below reaps grandchildren too — a hung `mix test` must not orphan a BEAM.
  const proc = Bun.spawn(["sh", "-c", cmd], {
    cwd: opts.cwd,
    env: opts.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });

  // Start reads BEFORE awaiting exit — a child blocked writing to a full
  // unread pipe would never exit, and these reads are also what preserve
  // partial output produced before a timeout kill.
  const stdoutP = new Response(proc.stdout).text();
  const stderrP = new Response(proc.stderr).text();

  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const killGroup = (sig: "SIGTERM" | "SIGKILL") => {
    try {
      // Negative pid = POSIX process-group kill (whole tree).
      process.kill(-proc.pid, sig);
    } catch {
      try {
        proc.kill(sig);
      } catch {
        // Process already gone
      }
    }
  };
  const termTimer = setTimeout(() => {
    // Guard the exit-vs-timer race: a command finishing exactly at the
    // deadline must not be mislabeled as timed out.
    if (proc.exitCode === null && proc.signalCode === null) {
      timedOut = true;
      killGroup("SIGTERM");
      killTimer = setTimeout(() => killGroup("SIGKILL"), opts.killGraceMs);
    }
  }, opts.timeoutMs);

  try {
    await proc.exited;
  } finally {
    clearTimeout(termTimer);
    if (killTimer) clearTimeout(killTimer);
  }

  const [stdout, stderr] = await Promise.all([stdoutP, stderrP]);
  // Killed-by-signal leaves exitCode null; timeout reports 124 by convention.
  const exitCode = timedOut ? TIMEOUT_EXIT_CODE : (proc.exitCode ?? 1);
  return { exitCode, stdout, stderr, timedOut };
}

export async function executeHookCommands(
  hookName: HookName,
  commands: string[],
  opts: ExecOptions,
): Promise<HookResult> {
  const now = opts.now ?? Date.now;
  const killGraceMs = opts.killGraceMs ?? KILL_GRACE_MS;
  const startTime = now();
  const completed: string[] = [];
  const outputs: CommandOutput[] = [];

  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i];
    const remaining = opts.budgetMs - (now() - startTime);

    let res: CommandRunResult;
    if (remaining <= 0) {
      // Section budget already spent — bash parity: fail with 124 without
      // ever spawning the command.
      res = {
        exitCode: TIMEOUT_EXIT_CODE,
        timedOut: true,
        stdout: "",
        stderr: `${Math.ceil(opts.budgetMs / 1000)}s section budget exhausted before this command started\n`,
      };
    } else {
      try {
        res = await runCommandWithBudget(cmd, {
          cwd: opts.cwd,
          env: opts.env,
          timeoutMs: remaining,
          killGraceMs,
        });
      } catch (err: unknown) {
        // Spawn failure (e.g. sh missing) — parity with the old catch path.
        res = { exitCode: 1, timedOut: false, stdout: "", stderr: String(err) };
      }
    }

    if (res.exitCode === 0) {
      completed.push(cmd);
      // (D65) Do NOT write the passing command's output to process.stderr — a
      // host that renders hook stderr as an error would mislabel a passing
      // gate. Instead fold a tail-truncated copy (same 2000-char cap as the
      // failure path) into commands_output on the success JSON.
      outputs.push({
        command: cmd,
        stdout: res.stdout.slice(-2000),
        stderr: res.stderr.slice(-2000),
      });
    } else {
      return {
        hook: hookName,
        status: "failed",
        commands_completed: completed,
        commands_remaining: commands.slice(i + 1),
        failed_command: cmd,
        command_index: i,
        exit_code: res.exitCode,
        timed_out: res.timedOut,
        budget_ms: opts.budgetMs,
        stdout: res.stdout.slice(-2000),
        stderr: res.stderr.slice(-2000),
        duration_ms: now() - startTime,
      };
    }
  }

  return {
    hook: hookName,
    status: "success",
    commands_completed: completed,
    commands_output: outputs,
    duration_ms: now() - startTime,
  };
}
