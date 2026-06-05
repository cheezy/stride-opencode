import type { Plugin } from "@opencode-ai/plugin";
import { parseStrideMd, buildCommandList, type HookName } from "./parser";
import { gateToolCall } from "./skill-gate";
import {
  captureChangedFiles,
  resolveStrideApiUrl,
  resolveStrideApiToken,
  putChangedFiles,
} from "./capture";

// Re-export parser functions for backwards compatibility
export { parseStrideMd, buildCommandList, buildCommandList as filterCommands, type HookName } from "./parser";
export { gateSkillActivation, gateToolCall, SKILL_ACTIVATION_TOOLS, PROTECTED_SUB_SKILLS } from "./skill-gate";
export {
  captureChangedFiles,
  extractApiBase,
  extractToken,
  resolveStrideApiUrl,
  resolveStrideApiToken,
  putChangedFiles,
  AUTH_FILE,
  TRUNC_MARKER,
  BIN_PLACEHOLDER,
  MAX_LINES,
  type ChangedFile,
} from "./capture";

// --- Stride API call detection ---

const CLAIM_PATTERN = /\/api\/tasks\/claim/;
const COMPLETE_PATTERN = /\/api\/tasks\/[^/]+\/complete/;
const MARK_REVIEWED_PATTERN = /\/api\/tasks\/[^/]+\/mark_reviewed/;

interface HookResult {
  hook: HookName;
  status: "success" | "failed" | "skipped";
  commands_completed: string[];
  commands_remaining?: string[];
  failed_command?: string;
  command_index?: number;
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  duration_ms: number;
}

interface EnvCache {
  [key: string]: string;
}

// --- Stride API call routing ---

export function detectHook(
  phase: "before" | "after",
  command: string,
): HookName | null {
  if (phase === "after") {
    if (CLAIM_PATTERN.test(command)) return "before_doing";
    if (MARK_REVIEWED_PATTERN.test(command)) return "after_review";
    if (COMPLETE_PATTERN.test(command)) return "before_review";
  } else if (phase === "before") {
    if (COMPLETE_PATTERN.test(command)) return "after_doing";
  }
  return null;
}

// --- Tool payload extraction helpers ---
//
// opencode delivers the tool payload to `tool.execute.before/after` under a
// nested `.input` object whose runtime shape differs from the SDK's declared
// `{tool, sessionID, callID, args}` types. These helpers probe defensively and
// treat their arguments as `unknown` so the same wiring works across hosts.

/** Pull the shell command string from a tool.execute payload. */
export function extractCommand(input: unknown): string {
  const inner = (input as { input?: { command?: string; args?: string[] } })
    ?.input;
  return inner?.command || inner?.args?.[0] || "";
}

/** Pull the tool name from a tool.execute.before payload. */
export function extractToolName(input: unknown): string {
  return (
    (input as { tool?: string })?.tool ??
    (input as { input?: { tool?: string } })?.input?.tool ??
    ""
  );
}

/** Pull the tool arguments from a tool.execute.before input/output pair. */
export function extractToolArgs(input: unknown, output: unknown): unknown {
  return (
    (output as { args?: unknown })?.args ??
    (input as { input?: unknown })?.input ??
    undefined
  );
}

// --- Environment variable extraction from claim response ---

export function extractEnvFromResponse(responseText: string): EnvCache {
  const env: EnvCache = {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    // Response not JSON — skip env extraction
    return env;
  }

  if (!parsed || typeof parsed !== "object") return env;

  // tool_response may arrive in three shapes depending on the host:
  //   1. {"stdout": "<api-json-string>", ...} — Bash-tool wrapper shape used
  //      by some hosts (Claude Code). Peel the .stdout layer and parse.
  //   2. {"data": {...}}                      — raw wrapped API response
  //   3. {"id": ...}                          — raw unwrapped API response
  let data: unknown;

  const outerStdout = (parsed as { stdout?: unknown }).stdout;
  if (typeof outerStdout === "string") {
    try {
      const inner = JSON.parse(outerStdout) as { data?: unknown } | null;
      data = (inner && inner.data) || inner;
    } catch {
      // .stdout not JSON — fall through to shapes 2/3
    }
  }

  if (!data) {
    data = (parsed as { data?: unknown }).data || parsed;
  }

  if (!data || typeof data !== "object") return env;
  const rec = data as Record<string, unknown>;

  if (rec.id) env.TASK_ID = String(rec.id);
  if (rec.identifier) env.TASK_IDENTIFIER = rec.identifier as string;
  if (rec.title) env.TASK_TITLE = rec.title as string;
  if (rec.status) env.TASK_STATUS = rec.status as string;
  if (rec.complexity) env.TASK_COMPLEXITY = rec.complexity as string;
  if (rec.priority) env.TASK_PRIORITY = rec.priority as string;
  if (rec.needs_review !== undefined)
    env.TASK_NEEDS_REVIEW = String(rec.needs_review);
  if (rec.description) env.TASK_DESCRIPTION = rec.description as string;

  return env;
}

// --- After-goal detection ---

/**
 * Detect an `after_goal` entry in the response's `hooks` array. Mirrors
 * stride-hook.sh:response_has_after_goal (W504). Handles the same three
 * payload shapes as extractEnvFromResponse:
 *   1. {"stdout": "<api-json-string>", ...} — Bash-tool wrapper
 *   2. {"data": {...}, "hooks": [...]}      — raw wrapped API response
 *   3. Direct payload object with .hooks at top level
 *
 * The `output` argument matches what opencode passes to `tool.execute.after`
 * — either a string, an object with a `.output` or `.result` string, or a
 * raw object payload.
 */
export function responseHasAfterGoal(output: unknown): boolean {
  if (output == null) return false;

  // Coerce `output` to the JSON-text view of the response payload.
  let responseText: string | undefined;
  if (typeof output === "string") {
    responseText = output;
  } else if (typeof output === "object") {
    const wrapped =
      (output as { output?: unknown }).output ??
      (output as { result?: unknown }).result;
    if (typeof wrapped === "string") {
      responseText = wrapped;
    } else if (wrapped != null) {
      responseText = JSON.stringify(wrapped);
    } else {
      responseText = JSON.stringify(output);
    }
  }
  if (!responseText) return false;

  try {
    const parsed: unknown = JSON.parse(responseText);

    // Peel the Bash-tool wrapper if present
    let payload: unknown = parsed;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { stdout?: unknown }).stdout === "string"
    ) {
      try {
        payload = JSON.parse((parsed as { stdout: string }).stdout);
      } catch {
        payload = parsed;
      }
    }

    if (!payload || typeof payload !== "object") return false;
    const hooks = (payload as { hooks?: unknown }).hooks;
    if (!Array.isArray(hooks)) return false;

    return hooks.some(
      (h) =>
        h &&
        typeof h === "object" &&
        (h as { name?: unknown }).name === "after_goal",
    );
  } catch {
    return false;
  }
}

// --- Plugin export ---

export const StridePlugin: Plugin = async ({
  directory,
  worktree,
  $,
}) => {
  const projectDir = worktree || directory;
  let envCache: EnvCache = {};
  const snapshotPath = `${projectDir}/.stride-changed-files.json`;

  // Capture git HEAD as TASK_BASE_REF so finalize_after_doing has an anchor.
  async function captureBaseRef(): Promise<string | undefined> {
    try {
      const result = await $`git rev-parse HEAD`
        .cwd(projectDir)
        .quiet()
        .nothrow();
      const rev = result.stdout.toString().trim();
      return rev || undefined;
    } catch {
      return undefined;
    }
  }

  // Remove a stale .stride-changed-files.json from a prior task so the new
  // task's after_doing capture starts from a clean slate.
  async function clearStaleSnapshot(): Promise<void> {
    try {
      await Bun.file(snapshotPath).unlink();
    } catch {
      // File didn't exist — that's the expected path
    }
  }

  // Write the changed-files snapshot after after_doing succeeds, then
  // fire-and-forget PUT it to the Stride server (G162 + G174). The on-disk
  // snapshot is preserved so legacy --argjson cf consumers on older
  // deployments still read it; the PUT carries the new wire-shape
  // ({changed_files: [...]}) to v1.16.0+ servers.
  async function finalizeAfterDoing(command: string): Promise<void> {
    let snapshot: { path: string; diff: string }[] = [];
    try {
      snapshot = await captureChangedFiles(
        $,
        projectDir,
        envCache.TASK_BASE_REF,
      );
      await Bun.write(snapshotPath, JSON.stringify(snapshot, null, 2) + "\n");
    } catch {
      // Best-effort — never throw from the capture path
    }

    // PUT prerequisites: TASK_ID from the claim env cache; URL + token resolved
    // from $projectDir/.stride_auth.md (primary, D54) with the intercepted
    // /complete command literals as the back-compat fallback. Missing any of
    // them is a silent no-op (the on-disk snapshot remains the fallback for
    // older servers).
    const apiBase = await resolveStrideApiUrl(projectDir, command);
    const token = await resolveStrideApiToken(projectDir, command);
    await putChangedFiles(apiBase, token, envCache.TASK_ID, snapshot);
  }

  async function readStrideMd(): Promise<string | null> {
    const path = `${projectDir}/.stride.md`;
    try {
      const file = Bun.file(path);
      if (await file.exists()) {
        return await file.text();
      }
    } catch {
      // File not found or unreadable
    }
    return null;
  }

  async function executeCommands(
    hookName: HookName,
    commands: string[],
  ): Promise<HookResult> {
    const startTime = Date.now();
    const completed: string[] = [];

    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i];
      try {
        const result =
          await $`cd ${projectDir} && ${envToExport(envCache)}${cmd}`.quiet();
        completed.push(cmd);

        // Log stdout/stderr to debug
        if (result.stdout.toString().trim()) {
          process.stderr.write(result.stdout);
        }
        if (result.stderr.toString().trim()) {
          process.stderr.write(result.stderr);
        }
      } catch (err: unknown) {
        const duration = Date.now() - startTime;
        const exitCode =
          err && typeof err === "object" && "exitCode" in err
            ? (err as { exitCode: number }).exitCode
            : 1;
        const stdout =
          err && typeof err === "object" && "stdout" in err
            ? (err as { stdout: Buffer }).stdout.toString().slice(-2000)
            : "";
        const stderr =
          err && typeof err === "object" && "stderr" in err
            ? (err as { stderr: Buffer }).stderr.toString().slice(-2000)
            : String(err);

        return {
          hook: hookName,
          status: "failed",
          commands_completed: completed,
          commands_remaining: commands.slice(i + 1),
          failed_command: cmd,
          command_index: i,
          exit_code: exitCode,
          stdout,
          stderr,
          duration_ms: duration,
        };
      }
    }

    return {
      hook: hookName,
      status: "success",
      commands_completed: completed,
      duration_ms: Date.now() - startTime,
    };
  }

  function envToExport(env: EnvCache): string {
    const entries = Object.entries(env);
    if (entries.length === 0) return "";
    return (
      entries
        .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
        .join(" && ") + " && "
    );
  }

  // Serialize a HookResult into the JSON shape stride-hook.sh emits on stdout
  // (used by after_goal so the agent can forward {exit_code, output, duration}
  // via PATCH /api/tasks/:goal_id/after_goal). Success and failure shapes
  // mirror the bash version verbatim except for `duration_ms` (vs bash's
  // `duration_seconds`) — opencode's HookResult tracks ms throughout.
  function formatHookResultJson(result: HookResult): string {
    if (result.status === "failed") {
      return JSON.stringify({
        hook: result.hook,
        status: "failed",
        failed_command: result.failed_command,
        command_index: result.command_index,
        exit_code: result.exit_code,
        stdout: result.stdout,
        stderr: result.stderr,
        commands_completed: result.commands_completed,
        commands_remaining: result.commands_remaining,
        duration_ms: result.duration_ms,
      });
    }
    return JSON.stringify({
      hook: result.hook,
      status: "success",
      commands_completed: result.commands_completed,
      duration_ms: result.duration_ms,
    });
  }

  return {
    "tool.execute.before": async (input, output) => {
      // --- Skill-activation gate ---
      // Block direct activation of internal Stride sub-skills unless the
      // stride-workflow orchestrator wrote the activation marker. Non-skill
      // tool calls and non-Stride skills fall through to the bash hook below.
      const toolName = extractToolName(input);
      const toolArgs = extractToolArgs(input, output);
      if (toolName) {
        const gateResult = gateToolCall(toolName, toolArgs, projectDir);
        if (gateResult !== "allow") {
          throw new Error(JSON.stringify(gateResult));
        }
      }

      // Extract command from tool input
      const command = extractCommand(input);
      if (!command) return;

      const hookName = detectHook("before", command);
      if (!hookName) return;

      const strideMd = await readStrideMd();
      if (!strideMd) return;

      const commands = parseStrideMd(strideMd, hookName);
      // after_doing fires on PreToolUse-for-/complete; even when the user's
      // .stride.md has no after_doing commands, we still need to write the
      // diff snapshot so the upcoming /complete curl picks it up inline.
      if (commands.length === 0) {
        if (hookName === "after_doing") await finalizeAfterDoing(command);
        return;
      }

      const result = await executeCommands(hookName, commands);

      if (result.status === "failed") {
        // Throw to block the tool call (like exit 2 in bash hooks)
        throw new Error(
          JSON.stringify({
            hook: result.hook,
            status: "failed",
            failed_command: result.failed_command,
            command_index: result.command_index,
            exit_code: result.exit_code,
            stdout: result.stdout,
            stderr: result.stderr,
            commands_completed: result.commands_completed,
            commands_remaining: result.commands_remaining,
          }),
        );
      }

      // Write the per-file diff snapshot after after_doing succeeds, and
      // fire-and-forget PUT it to the Stride server (G162 + G174).
      if (hookName === "after_doing") {
        await finalizeAfterDoing(command);
      }
    },

    "tool.execute.after": async (input, output) => {
      const command = extractCommand(input);
      if (!command) return;

      const hookName = detectHook("after", command);
      if (!hookName) return;

      // Cache environment variables from claim response
      if (hookName === "before_doing" && output) {
        const responseText =
          typeof output === "string"
            ? output
            : output?.output ||
              (output as { result?: string })?.result ||
              "";
        if (responseText) {
          envCache = {
            ...envCache,
            ...extractEnvFromResponse(
              typeof responseText === "string"
                ? responseText
                : JSON.stringify(responseText),
            ),
          };
        }
        // Capture current git HEAD as TASK_BASE_REF so capture_changed_files
        // has an anchor when after_doing runs. Best-effort — non-git
        // projects just won't get the env var.
        const baseRef = await captureBaseRef();
        if (baseRef) envCache.TASK_BASE_REF = baseRef;
        // Clear any stale changed-files snapshot from a prior task.
        await clearStaleSnapshot();
      }

      const strideMd = await readStrideMd();
      if (!strideMd) return;

      const commands = parseStrideMd(strideMd, hookName);
      let primarySucceeded = true;

      if (commands.length > 0) {
        const result = await executeCommands(hookName, commands);
        if (result.status === "failed") {
          primarySucceeded = false;
          process.stderr.write(
            `Stride ${hookName} hook failed: ${result.failed_command}\n`,
          );
          if (result.stderr) {
            process.stderr.write(result.stderr + "\n");
          }
        }
      }
      // commands.length === 0 is treated as success (primary section was an
      // empty no-op — matches the original behavior at the pre-W793 early
      // return for that branch).

      // Clean up env cache and snapshot after the final hook in the lifecycle.
      // Runs regardless of primary success/failure (matches pre-W793 behavior
      // where the cleanup at lines 348-352 fired before the failure-logging
      // block at 354-360).
      if (hookName === "after_review") {
        envCache = {};
        await clearStaleSnapshot();
      }

      // --- After-goal routing (W793 / mirrors stride v1.17.1 W504) ---
      // When the server bundles an `after_goal` entry in the response of
      // /complete or /mark_reviewed (last-child-of-goal case), run the local
      // `## after_goal` section as a blocking hook. Missing `## after_goal`
      // in .stride.md is a clean no-op (back-compat). Structured success or
      // failure JSON is written to stdout for the agent to forward via
      // PATCH /api/tasks/:goal_id/after_goal. We do NOT throw — the primary
      // curl has already returned, so blocking would have no effect.
      if (
        primarySucceeded &&
        (hookName === "before_review" || hookName === "after_review") &&
        responseHasAfterGoal(output)
      ) {
        const agCommands = parseStrideMd(strideMd, "after_goal");
        if (agCommands.length > 0) {
          const agResult = await executeCommands("after_goal", agCommands);
          process.stdout.write(formatHookResultJson(agResult) + "\n");
        }
        // agCommands.length === 0 → silent no-op (back-compat); the server's
        // grace-window worker promotes the goal after the configured wait.
      }
    },
  };
};

export default StridePlugin;
