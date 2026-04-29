import type { Plugin } from "@opencode-ai/plugin";
import { parseStrideMd, buildCommandList, type HookName } from "./parser";
import { gateToolCall } from "./skill-gate";

// Re-export parser functions for backwards compatibility
export { parseStrideMd, buildCommandList, buildCommandList as filterCommands, type HookName } from "./parser";
export { gateSkillActivation, gateToolCall, SKILL_ACTIVATION_TOOLS, PROTECTED_SUB_SKILLS } from "./skill-gate";

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

// --- Environment variable extraction from claim response ---

export function extractEnvFromResponse(responseText: string): EnvCache {
  const env: EnvCache = {};
  try {
    const parsed = JSON.parse(responseText);

    // tool_response may arrive in three shapes depending on the host:
    //   1. {"stdout": "<api-json-string>", ...} — Bash-tool wrapper shape used
    //      by some hosts (Claude Code). Peel the .stdout layer and parse.
    //   2. {"data": {...}}                      — raw wrapped API response
    //   3. {"id": ...}                          — raw unwrapped API response
    let data: Record<string, unknown> | undefined;

    if (parsed && typeof parsed === "object" && typeof parsed.stdout === "string") {
      try {
        const inner = JSON.parse(parsed.stdout);
        data = (inner && inner.data) || inner;
      } catch {
        // .stdout not JSON — fall through to shapes 2/3
      }
    }

    if (!data) {
      data = parsed.data || parsed;
    }

    if (!data || typeof data !== "object") return env;

    if (data.id) env.TASK_ID = String(data.id);
    if (data.identifier) env.TASK_IDENTIFIER = data.identifier as string;
    if (data.title) env.TASK_TITLE = data.title as string;
    if (data.status) env.TASK_STATUS = data.status as string;
    if (data.complexity) env.TASK_COMPLEXITY = data.complexity as string;
    if (data.priority) env.TASK_PRIORITY = data.priority as string;
    if (data.needs_review !== undefined)
      env.TASK_NEEDS_REVIEW = String(data.needs_review);
    if (data.description) env.TASK_DESCRIPTION = data.description as string;
  } catch {
    // Response not JSON — skip env extraction
  }
  return env;
}

// --- Plugin export ---

export const StridePlugin: Plugin = async ({
  directory,
  worktree,
  $,
}) => {
  const projectDir = worktree || directory;
  let envCache: EnvCache = {};

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

  return {
    "tool.execute.before": async (input, output) => {
      // --- Skill-activation gate ---
      // Block direct activation of internal Stride sub-skills unless the
      // stride-workflow orchestrator wrote the activation marker. Non-skill
      // tool calls and non-Stride skills fall through to the bash hook below.
      const toolName =
        (input as { tool?: string })?.tool ??
        (input as { input?: { tool?: string } })?.input?.tool ??
        "";
      const toolArgs =
        (output as { args?: unknown })?.args ??
        (input as { input?: unknown })?.input ??
        undefined;
      if (toolName) {
        const gateResult = gateToolCall(toolName, toolArgs, projectDir);
        if (gateResult !== "allow") {
          throw new Error(JSON.stringify(gateResult));
        }
      }

      // Extract command from tool input
      const command =
        (input as { input?: { command?: string; args?: string[] } })?.input?.command ||
        (input as { input?: { command?: string; args?: string[] } })?.input?.args?.[0] ||
        "";
      if (!command) return;

      const hookName = detectHook("before", command);
      if (!hookName) return;

      const strideMd = await readStrideMd();
      if (!strideMd) return;

      const commands = parseStrideMd(strideMd, hookName);
      if (commands.length === 0) return;

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
    },

    "tool.execute.after": async (input, output) => {
      const command =
        (input as { input?: { command?: string; args?: string[] } })?.input?.command ||
        (input as { input?: { command?: string; args?: string[] } })?.input?.args?.[0] ||
        "";
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
      }

      const strideMd = await readStrideMd();
      if (!strideMd) return;

      const commands = parseStrideMd(strideMd, hookName);
      if (commands.length === 0) return;

      const result = await executeCommands(hookName, commands);

      // Clean up env cache after the final hook in the lifecycle
      if (hookName === "after_review") {
        envCache = {};
      }

      if (result.status === "failed") {
        process.stderr.write(
          `Stride ${hookName} hook failed: ${result.failed_command}\n`,
        );
        if (result.stderr) {
          process.stderr.write(result.stderr + "\n");
        }
      }
    },
  };
};

export default StridePlugin;
