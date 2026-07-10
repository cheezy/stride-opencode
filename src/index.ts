import type { Plugin } from "@opencode-ai/plugin";
import { parseStrideMd, buildCommandList, type HookName } from "./parser";
import { gateToolCall } from "./skill-gate";
import {
  executeHookCommands,
  resolveHookTimeoutMs,
  type HookResult,
} from "./hook-exec";
import {
  captureChangedFiles,
  resolveStrideApiUrl,
  resolveStrideApiToken,
  putChangedFiles,
  recordDiffUploadState,
  readDiffUploadState,
  markDiffUploadUnresolved,
  writeEnvCache,
  readEnvCache,
  clearEnvCache,
  writeCanonicalResponse,
  readCanonicalResponse,
  getAfterGoalStatus,
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
  recordDiffUploadState,
  readDiffUploadState,
  markDiffUploadUnresolved,
  writeEnvCache,
  readEnvCache,
  clearEnvCache,
  writeCanonicalResponse,
  readCanonicalResponse,
  getAfterGoalStatus,
  ENV_CACHE_FILE,
  CANONICAL_RESPONSE_FILE,
  AUTH_FILE,
  TRUNC_MARKER,
  BIN_PLACEHOLDER,
  MAX_LINES,
  type ChangedFile,
  type AfterGoalStatus,
} from "./capture";
export {
  executeHookCommands,
  resolveHookTimeoutMs,
  HOOK_TIMEOUTS_MS,
  KILL_GRACE_MS,
  TIMEOUT_EXIT_CODE,
  type HookResult,
  type CommandOutput,
  type ExecOptions,
} from "./hook-exec";

// --- Stride API call detection ---

const CLAIM_PATTERN = /\/api\/tasks\/claim/;
const COMPLETE_PATTERN = /\/api\/tasks\/[^/]+\/complete/;
const MARK_REVIEWED_PATTERN = /\/api\/tasks\/[^/]+\/mark_reviewed/;

// (D127) Extract the authoritative numeric task id from a /complete or
// /mark_reviewed command URL. The after_doing finalize and before_review
// self-heal paths always process such a command, whose URL carries the real
// task id — preferring it over the env-cache TASK_ID guards against a stale or
// corrupt cache targeting the changed_files PUT at the wrong (previous) task.
// Pure string parse, no network call. Mirrors task_id_from_command in
// stride/hooks/stride-hook.sh: only a bare numeric id is accepted; a claim/next
// URL or a non-numeric segment yields null (the caller then falls back to the
// env-cache id). The capturing, digit-only regex is intentionally distinct from
// the structural COMPLETE_PATTERN / MARK_REVIEWED_PATTERN above, which route on
// shape (any segment) rather than identity.
const TASK_ID_FROM_COMMAND_PATTERN =
  /\/api\/tasks\/(\d+)\/(?:complete|mark_reviewed)/;

export function taskIdFromCommand(command: string): string | null {
  const match = TASK_ID_FROM_COMMAND_PATTERN.exec(command);
  return match ? match[1] : null;
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

// --- Response payload peeling (shared by after-goal detection and hook env) ---

/**
 * Coerce the `tool.execute.after` `output` argument to the JSON-text view of
 * the response payload — a string as-is, an object's `.output`/`.result`
 * string, or the JSON-serialized object itself. Returns "" when there is
 * nothing to read.
 */
export function coerceOutputText(output: unknown): string {
  if (output == null) return "";
  if (typeof output === "string") return output;
  if (typeof output === "object") {
    let wrapped = (output as { output?: unknown }).output;
    // An empty-string .output counts as absent so a populated .result still
    // wins — preserves the pre-W1497 claim-branch fallthrough semantics.
    if (wrapped == null || wrapped === "") {
      wrapped = (output as { result?: unknown }).result ?? wrapped;
    }
    if (typeof wrapped === "string") return wrapped;
    if (wrapped != null) return JSON.stringify(wrapped);
    return JSON.stringify(output);
  }
  return "";
}

/**
 * Parse the response text and peel the Bash-tool `{stdout: "<json>"}`
 * wrapper (if present), landing at the payload ROOT — where `hook`/`hooks`
 * live as siblings of `data`. Returns null when the text is not a JSON
 * object. Handles the same three payload shapes as extractEnvFromResponse
 * (which peels one level deeper, to `.data`).
 */
export function peelPayloadRoot(
  responseText: string,
): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(responseText);
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
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return null;
    }
    return payload as Record<string, unknown>;
  } catch {
    return null;
  }
}

// --- Canonical response file: capture + file-first resolution (W1637) ---

/**
 * (W1637) Best-effort capture of the current `tool.execute.after` response to
 * the canonical file (`${projectDir}/.stride/.last-api-response.json`), the
 * read side of stride D118/W1609 ported to opencode. Writes ONLY when
 * `coerceOutputText(output)` is complete valid JSON — a truncated or empty
 * output parses as invalid and is skipped, so it never overwrites a good
 * prior-call file, while a valid current output DOES overwrite a stale one
 * (mirrors the bash hook's `capture_canonical_response`). Never throws.
 */
async function captureCanonicalResponse(
  projectDir: string,
  output: unknown,
): Promise<void> {
  const text = coerceOutputText(output);
  if (!text) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Incomplete/invalid JSON (e.g. a harness-truncated response) — leave any
    // prior valid capture in place rather than clobbering it with garbage.
    return;
  }
  await writeCanonicalResponse(projectDir, parsed);
}

/**
 * (W1637) Resolve the single JSON-text view of the response, preferring the
 * canonical file over the harness-truncatable `output`. The agent's API curl
 * tees the FULL response to the canonical file, so when opencode hands the
 * plugin a truncated `output`, the file still carries the complete payload
 * (including any `after_goal` entry and its GOAL_* env). Falls back to
 * `coerceOutputText(output)` when the file is absent, unreadable, or invalid —
 * so detection and env extraction keep working exactly as before when no file
 * is present. Call AFTER {@link captureCanonicalResponse} so a valid current
 * output has already refreshed the file.
 */
async function preferCanonicalResponseText(
  projectDir: string,
  output: unknown,
): Promise<string> {
  const fromFile = await readCanonicalResponse(projectDir);
  if (fromFile != null) {
    try {
      return JSON.stringify(fromFile);
    } catch {
      // A value that cannot be re-serialized — fall back to the tool output.
    }
  }
  return coerceOutputText(output);
}

// --- After-goal detection ---

/**
 * Detect an `after_goal` entry in the response's `hooks` array. Mirrors
 * stride-hook.sh:response_has_after_goal (W504).
 *
 * The `output` argument matches what opencode passes to `tool.execute.after`
 * — either a string, an object with a `.output` or `.result` string, or a
 * raw object payload.
 */
export function responseHasAfterGoal(output: unknown): boolean {
  const payload = peelPayloadRoot(coerceOutputText(output));
  if (!payload) return false;
  const hooks = payload.hooks;
  if (!Array.isArray(hooks)) return false;

  return hooks.some(
    (h) =>
      h &&
      typeof h === "object" &&
      (h as { name?: unknown }).name === "after_goal",
  );
}

// --- Server-supplied hook env extraction (W1497) ---

/**
 * Extract the server-supplied env for the named hook from an API response.
 * Mirrors stride-hook.sh:extract_hook_env: claim responses carry a SINGULAR
 * `hook` object, complete/mark_reviewed carry a `hooks` ARRAY — both are
 * candidates. Returns {} when the response carries no matching entry (older
 * servers omit hooks entirely — that is not an error), so keys the server
 * omits are simply absent, never invented.
 *
 * TASK_BASE_REF is dropped — it is the client-owned diff anchor and must
 * never be server-overridden. HOOK_NAME IS returned (callers deliver it
 * ephemerally but exclude it from the persisted cache, where a stale value
 * would mislead later hooks).
 */
export function extractHookEnvFromResponse(
  responseText: string,
  hookName: HookName,
): EnvCache {
  const root = peelPayloadRoot(responseText);
  if (!root) return {};

  const candidates: unknown[] = Array.isArray(root.hooks) ? [...root.hooks] : [];
  if (root.hook && typeof root.hook === "object" && !Array.isArray(root.hook)) {
    candidates.push(root.hook);
  }

  const entry = candidates.find(
    (h) =>
      h && typeof h === "object" && (h as { name?: unknown }).name === hookName,
  );
  if (!entry) return {};

  const rawEnv = (entry as { env?: unknown }).env;
  if (!rawEnv || typeof rawEnv !== "object" || Array.isArray(rawEnv)) return {};

  const env: EnvCache = {};
  for (const [key, value] of Object.entries(rawEnv)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (key === "TASK_BASE_REF") continue;
    if (typeof value === "string") env[key] = value;
    else if (typeof value === "number" || typeof value === "boolean")
      env[key] = String(value);
    // null/object/array values are skipped — no invented values
  }
  return env;
}

// --- Plugin export ---

export const StridePlugin: Plugin = async (input) => {
  const { directory, worktree, $ } = input;
  // (W1495) Test-only injection: PluginInput is a closed type, so tiny hook
  // budgets and kill-grace ride in via the same `as never` cast the tests
  // already use to instantiate the plugin.
  const { hookTimeoutsMs, killGraceMs } = input as unknown as {
    hookTimeoutsMs?: Partial<Record<HookName, number>>;
    killGraceMs?: number;
  };
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

  // (W1094) Remove a stale .stride-diff-upload-state from a prior task — a
  // leftover 2xx would otherwise suppress the new task's before_review
  // self-heal retry.
  const uploadStatePath = `${projectDir}/.stride-diff-upload-state`;
  async function clearDiffUploadState(): Promise<void> {
    try {
      await Bun.file(uploadStatePath).unlink();
    } catch {
      // File didn't exist — that's the expected path
    }
  }

  // (W1496) Lazily rehydrate the env cache from disk after a plugin restart.
  // Only fires when the in-memory cache is empty; a populated cache always
  // wins. Mirrors the bash hook's source-the-cache-every-invocation pattern.
  async function loadEnvCacheIfEmpty(): Promise<void> {
    if (Object.keys(envCache).length > 0) return;
    envCache = await readEnvCache(projectDir);
  }

  // Write the changed-files snapshot after after_doing succeeds, then
  // fire-and-forget PUT it to the Stride server (G162 + G174). The on-disk
  // snapshot is preserved so legacy --argjson cf consumers on older
  // deployments still read it; the PUT carries the new wire-shape
  // ({changed_files: [...]}) to v1.16.0+ servers.
  async function finalizeAfterDoing(command: string): Promise<void> {
    await loadEnvCacheIfEmpty();
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

    // PUT prerequisites: the task id preferentially resolved from the /complete
    // command URL (D127) — authoritative even when the env cache is stale or
    // corrupt — falling back to the claim env cache's TASK_ID only when the URL
    // carries no id. URL + token resolved from $projectDir/.stride_auth.md
    // (primary, D54) with the intercepted /complete command literals as the
    // back-compat fallback. Missing any of them is a silent no-op (the on-disk
    // snapshot remains the fallback for older servers).
    const taskId = taskIdFromCommand(command) ?? envCache.TASK_ID;
    const apiBase = await resolveStrideApiUrl(projectDir, command);
    const token = await resolveStrideApiToken(projectDir, command);
    const httpCode = await putChangedFiles(apiBase, token, taskId, snapshot);
    // (W1094) Record the outcome after every actual PUT attempt so the
    // before_review self-heal can verify it on a fresh budget. A skipped PUT
    // (null — missing prerequisites) deliberately records nothing: missing
    // state means "no healthy upload on record" and the retry re-checks the
    // same prerequisites itself.
    if (httpCode !== null && taskId) {
      await recordDiffUploadState(projectDir, taskId, httpCode);
    }
  }

  // (W1094) Self-heal for the changed_files upload. The after_doing gate can
  // burn the whole hook budget, killing the process before or during the
  // snapshot PUT — or the PUT itself returned non-2xx. before_review (the
  // tool.execute.after pass on the same /complete call) runs on a FRESH budget,
  // so it verifies the recorded outcome and re-captures + re-PUTs when no
  // healthy upload is on record for the current task. Best-effort: never throws.
  async function selfHealChangedFilesUpload(command: string): Promise<void> {
    await loadEnvCacheIfEmpty();
    // (D127) Prefer the id from the /complete|/mark_reviewed command URL over
    // the env cache, so a stale cache can't self-heal the wrong task; the
    // env-cache TASK_ID remains the fallback when the URL carries no id.
    const taskId = taskIdFromCommand(command) ?? envCache.TASK_ID;
    if (!taskId) return;

    // Healthy 2xx recorded for THIS task → do not re-upload (snapshot semantics
    // anchor at after_doing time; avoid pointless API load). Short-circuit
    // BEFORE resolving credentials so a healthy state never reads them.
    const state = await readDiffUploadState(projectDir);
    if (state && state.taskId === taskId && /^2/.test(state.httpCode)) return;

    const apiBase = await resolveStrideApiUrl(projectDir, command);
    const token = await resolveStrideApiToken(projectDir, command);
    if (!apiBase || !token) return;

    // Re-capture against the claim-time base ref and re-PUT.
    let snapshot: { path: string; diff: string }[] = [];
    try {
      snapshot = await captureChangedFiles($, projectDir, envCache.TASK_BASE_REF);
      await Bun.write(snapshotPath, JSON.stringify(snapshot, null, 2) + "\n");
    } catch {
      // Best-effort — never throw from the capture path
    }
    const httpCode = await putChangedFiles(apiBase, token, taskId, snapshot);
    if (httpCode !== null) {
      await recordDiffUploadState(projectDir, taskId, httpCode);
      // (W1658) before_review is the LAST upload retry. A non-2xx here — an
      // error status or a transport failure (putChangedFiles returns 0) — means
      // the changed_files diff is definitively lost for this task. Surface it
      // LOUDLY, distinct from the per-attempt warning inside putChangedFiles,
      // and append an `unresolved=yes` marker so the failure is queryable rather
      // than silently swallowed. Fail-soft: this never vetoes the
      // already-succeeded /complete. A later successful PUT calls
      // recordDiffUploadState, which overwrites the file and clears the mark.
      if (httpCode < 200 || httpCode >= 300) {
        console.error(
          `stride-hook: CHANGED_FILES UPLOAD UNRESOLVED for task ${taskId} (HTTP ${httpCode}) after the before_review retry — the review will show NO file diffs. Re-run the changed_files PUT to recover.`,
        );
        await markDiffUploadUnresolved(projectDir);
      }
    }
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
    extraEnv?: EnvCache,
  ): Promise<HookResult> {
    await loadEnvCacheIfEmpty();
    // (D95) The env cache rides the child environment, never shell text, so
    // user-controlled values (e.g. task titles) cannot inject shell syntax.
    // process.env is filtered because undefined values are not env data.
    // (W1497) extraEnv is the server-supplied entry for THIS hook — applied
    // last so server values win, ephemeral so it never touches envCache.
    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) childEnv[k] = v;
    }
    Object.assign(childEnv, envCache, extraEnv ?? {});

    // (W1495) Execution — sh -c per line, section budget, group-kill on
    // expiry — lives in hook-exec.ts.
    return executeHookCommands(hookName, commands, {
      cwd: projectDir,
      env: childEnv,
      budgetMs: resolveHookTimeoutMs(hookName, hookTimeoutsMs),
      killGraceMs,
    });
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
        // (W1495) Mirrors the bash hook's timed_out/budget_seconds failure
        // fields, in ms to match duration_ms.
        timed_out: result.timed_out ?? false,
        budget_ms: result.budget_ms,
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
      // (D65) Per-command output folded into the success JSON instead of stderr.
      commands_output: result.commands_output ?? [],
      duration_ms: result.duration_ms,
    });
  }

  // (W793/W1638) Run the local `## after_goal` section with the given hook env
  // and emit its structured HookResult to stdout for the agent to forward via
  // PATCH /api/tasks/:goal_id/after_goal. An empty or absent section is a
  // silent no-op (back-compat — the server's grace-window worker promotes the
  // goal). Shared by the fast path (file/output detection) and the W1638
  // fresh-GET reliability fallback, so `## after_goal` runs at most once per
  // completion regardless of which detector fired.
  async function runAfterGoalSection(
    strideMd: string,
    extraEnv: EnvCache,
  ): Promise<void> {
    const agCommands = parseStrideMd(strideMd, "after_goal");
    if (agCommands.length === 0) return;
    const agResult = await executeCommands("after_goal", agCommands, extraEnv);
    process.stdout.write(formatHookResultJson(agResult) + "\n");
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

      // (W1093) Early per-file diff snapshot — capture and upload BEFORE the
      // gate commands run, so a slow or timed-out after_doing gate can't kill
      // the process before the diff upload completes. Gated on hookName so it
      // stays inert for non-after_doing hooks. The post-loop call below remains
      // as a refresh once the gate commands succeed (they may change files).
      if (hookName === "after_doing") {
        await finalizeAfterDoing(command);
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
            timed_out: result.timed_out ?? false,
            budget_ms: result.budget_ms,
            stdout: result.stdout,
            stderr: result.stderr,
            commands_completed: result.commands_completed,
            commands_remaining: result.commands_remaining,
          }),
        );
      }

      // (W1093) Refresh the per-file diff snapshot after after_doing succeeds —
      // the gate commands may have changed files since the early pre-loop
      // capture above. Fire-and-forget PUT to the Stride server (G162 + G174).
      if (hookName === "after_doing") {
        await finalizeAfterDoing(command);
      }
    },

    "tool.execute.after": async (input, output) => {
      const command = extractCommand(input);
      if (!command) return;

      const hookName = detectHook("after", command);
      if (!hookName) return;

      // (W1637) Persist the current response to the canonical file when it is
      // complete valid JSON — a valid current output overwrites a stale
      // prior-call file; a truncated one leaves the good file intact.
      await captureCanonicalResponse(projectDir, output);

      // (W1497/W1637) One JSON-text view of the response for every consumer
      // below — the claim-time derivation, the per-hook server env extraction,
      // and the after_goal detection + env. Prefers the canonical file (which
      // the API curl tee'd in full) over the harness-truncatable `output`,
      // falling back to the raw output when no file is present.
      const responseText = await preferCanonicalResponseText(projectDir, output);

      // Cache environment variables from claim response
      if (hookName === "before_doing" && output) {
        let envExtracted = false;
        if (responseText) {
          // (W1496) Fresh assignment, not a merge — a prior task's leftover
          // fields must not survive into the new claim (mirrors the bash
          // hook's truncating rewrite of .stride-env-cache on claim).
          envCache = { ...extractEnvFromResponse(responseText) };
          envExtracted = true;
        }
        // Capture current git HEAD as TASK_BASE_REF so capture_changed_files
        // has an anchor when after_doing runs. Best-effort — non-git
        // projects just won't get the env var.
        const baseRef = await captureBaseRef();
        if (baseRef) envCache.TASK_BASE_REF = baseRef;
        // (W1497) Merge the server's before_doing hook env over the derived
        // task-record values — the server is the source of truth on
        // collision. HOOK_NAME stays out of the cache: persisting it would
        // deliver a stale routing value to later hooks (it still reaches
        // before_doing commands ephemerally via extraEnv below).
        const { HOOK_NAME: _ephemeralHookName, ...persistable } =
          extractHookEnvFromResponse(responseText, "before_doing");
        Object.assign(envCache, persistable);
        // Clear any stale changed-files snapshot and upload-state from a prior
        // task (W1094 — a stale 2xx would suppress the new task's self-heal).
        await clearStaleSnapshot();
        await clearDiffUploadState();
        // (W1496) Persist the fully-populated cache so a host restart between
        // claim and complete doesn't lose TASK_ID/TASK_BASE_REF. Overwrites
        // any prior task's cache file. Gated on a successful extraction so a
        // claim with no readable response can't persist a stale prior-task
        // cache that was previously memory-only.
        if (envExtracted) {
          await writeEnvCache(projectDir, envCache);
        }
      }

      // (W1094) Changed-files upload self-heal — runs on the FRESH before_review
      // budget and re-uploads the snapshot when no healthy 2xx is on record for
      // the current task. Placed before the .stride.md early-return so it runs
      // even when there is no before_review section to execute.
      if (hookName === "before_review") {
        await selfHealChangedFilesUpload(command);
      }

      const strideMd = await readStrideMd();
      if (!strideMd) return;

      const commands = parseStrideMd(strideMd, hookName);
      let primarySucceeded = true;

      if (commands.length > 0) {
        // (W1497) Deliver the server-supplied entry for THIS hook ephemerally.
        // hookName here is only before_doing/before_review/after_review, so
        // the after_goal entry can never reach primary commands.
        const result = await executeCommands(
          hookName,
          commands,
          extractHookEnvFromResponse(responseText, hookName),
        );
        if (result.status === "failed") {
          primarySucceeded = false;
          // (W1495) Distinguish a timeout from an ordinary failure, mirroring
          // the bash hook's dual stderr phrasing.
          if (result.timed_out) {
            process.stderr.write(
              `Stride ${hookName} hook command ${(result.command_index ?? 0) + 1}/${commands.length} timed out after ${Math.ceil((result.budget_ms ?? 0) / 1000)}s budget: ${result.failed_command}\n`,
            );
          } else {
            process.stderr.write(
              `Stride ${hookName} hook failed: ${result.failed_command}\n`,
            );
          }
          if (result.stderr) {
            process.stderr.write(result.stderr + "\n");
          }
        }
      }
      // commands.length === 0 is treated as success (primary section was an
      // empty no-op — matches the original behavior at the pre-W793 early
      // return for that branch).

      // (W1638) The after_goal reliability fallback below is keyed off the
      // claim-cached TASK_ID. Resolve it HERE, before the after_review cleanup
      // wipes envCache (memory + disk) — otherwise a truncated last-child
      // /mark_reviewed would clear TASK_ID out from under the fallback and the
      // guarantee could never fire on the after_review path.
      const afterGoalEligible =
        primarySucceeded &&
        (hookName === "before_review" || hookName === "after_review");
      let afterGoalTaskId: string | undefined;
      if (afterGoalEligible) {
        await loadEnvCacheIfEmpty();
        afterGoalTaskId = envCache.TASK_ID;
      }

      // Clean up env cache and snapshot after the final hook in the lifecycle.
      // Runs regardless of primary success/failure (matches pre-W793 behavior
      // where the cleanup at lines 348-352 fired before the failure-logging
      // block at 354-360).
      if (hookName === "after_review") {
        envCache = {};
        await clearStaleSnapshot();
        await clearDiffUploadState();
        // (W1496) Remove the persisted cache too, so the cleared in-memory
        // state can't be rehydrated from disk. (The bash hook's after_goal
        // carve-out — keeping the cache when after_goal was just routed — is
        // out of scope here; opencode has always cleared unconditionally.)
        await clearEnvCache(projectDir);
      }

      // --- After-goal routing (W793 / mirrors stride v1.17.1 W504) ---
      // When /complete or /mark_reviewed finishes a goal's last child, run the
      // local `## after_goal` section as a blocking hook and write its
      // structured result to stdout for the agent to forward via
      // PATCH /api/tasks/:goal_id/after_goal. We do NOT throw — the primary curl
      // has already returned, so blocking would have no effect. Two independent
      // detectors feed one execution (`## after_goal` runs at most once).
      // `afterGoalEligible` and `afterGoalTaskId` were resolved above, before the
      // after_review cleanup, so the fallback survives on the /mark_reviewed path.

      // Fast path (W793/W1637): the after_goal entry present in the file-first
      // response — zero extra network cost. Detect against `responseText`, not
      // the raw `output` (a truncated output can drop the entry the canonical
      // file still carries; coerceOutputText passes the string through so
      // peeling behaves identically). GOAL_* rides the entry env, delivered
      // here and only here — never merged into envCache.
      let afterGoalHandled = false;
      if (afterGoalEligible && responseHasAfterGoal(responseText)) {
        await runAfterGoalSection(
          strideMd,
          extractHookEnvFromResponse(responseText, "after_goal"),
        );
        afterGoalHandled = true;
      }

      // Reliability fallback (W1638 / mirrors stride D119 commit 9e2ad49): the
      // plugin captures whatever (truncatable) output the host hands it, so both
      // the output and the canonical-file capture are best-effort. A
      // hook-initiated fresh GET /api/tasks/:id/after_goal_status — keyed off the
      // claim-cached TASK_ID, credentials resolved like every other API call —
      // is the real guarantee: it detects an armed after_goal independent of the
      // intercepted output or the file. Runs only when the fast path found
      // nothing (de-duped — never both), and is best-effort: a missing TASK_ID,
      // an unreachable endpoint, or a not-armed result is a silent no-op (the
      // server's grace-window worker still promotes the goal).
      if (afterGoalEligible && !afterGoalHandled) {
        // TASK_ID captured before the after_review cleanup (see above) so this
        // survives on both /complete and /mark_reviewed.
        const taskId = afterGoalTaskId;
        if (taskId) {
          const apiBase = await resolveStrideApiUrl(projectDir, command);
          const token = await resolveStrideApiToken(projectDir, command);
          const status = await getAfterGoalStatus(apiBase, token, taskId);
          if (status?.armed) {
            // GOAL_* rides the fresh result's env. GOAL_ID falls back to the
            // result's goalId when the server omits it from the hook env
            // (mirrors the bash hook's parent_id fallback).
            const agEnv: EnvCache = { ...status.env };
            if (!agEnv.GOAL_ID && status.goalId) agEnv.GOAL_ID = status.goalId;
            await runAfterGoalSection(strideMd, agEnv);
          }
        }
      }
    },
  };
};

export default StridePlugin;
