/**
 * Per-file diff capture (G148/W719 contract, Option D semantic)
 *
 * Mirrors the bash `capture_changed_files()` in stride/hooks/stride-hook.sh.
 * Emits an array of `{path, diff}` entries — one per file that differs
 * between the base ref and the agent's WORKING TREE at completion time.
 * Committed-since-base, staged-but-uncommitted, modified-but-unstaged, AND
 * untracked-but-not-gitignored changes all surface in a single pass so the
 * Stride review queue sees the agent's full working state regardless of
 * whether the agent committed before /complete.
 *
 * Truncates diffs over 500 lines with the contract marker
 * `[diff truncated at 500 lines]`. Emits `[binary file — no diff captured]`
 * for files git reports as binary in --numstat (tracked) or that --no-index
 * reports as binary (untracked). Falls back to HEAD~1 when the provided
 * base is empty or unresolvable. Returns `[]` for any degraded path (git
 * missing, not in a repo, no commits to diff) so callers can treat this
 * strictly as "best-effort capture" — it never throws.
 */
/**
 * Minimal structural view of Bun's tagged-template shell `$`.
 *
 * Captures only the surface this module uses — `.cwd()`/`.quiet()`/`.nothrow()`
 * chaining and the awaited `{stdout, stderr, exitCode}` result — so that both
 * Bun's global `$` (in tests) and the `@opencode-ai/plugin` context `$` (in
 * production) satisfy it structurally. We deliberately avoid the SDK's
 * `BunShell` type: it is not re-exported from `@opencode-ai/plugin`'s package
 * root, and Bun's own `$` type carries extra static members the plugin shell
 * lacks, so neither is assignable to the other. A minimal interface is the
 * only type both shells share. Interpolated expressions are limited to the
 * `string` and `string[]` forms this module actually passes (e.g. a git
 * argument list); widening beyond that would break assignability of the two
 * concrete `$` implementations.
 */
interface ShellCommandOutput {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly exitCode: number;
}

interface ShellCommandPromise extends Promise<ShellCommandOutput> {
  cwd(dir: string): ShellCommandPromise;
  quiet(): ShellCommandPromise;
  nothrow(): ShellCommandPromise;
}

type ShellHelper = (
  strings: TemplateStringsArray,
  ...expressions: (string | string[])[]
) => ShellCommandPromise;

// (W2150) The loop-state writer needs an atomic rename; Bun.write alone is
// not atomic. These are the only node: imports in this module.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";

export interface ChangedFile {
  path: string;
  diff: string;
}

export const TRUNC_MARKER = "[diff truncated at 500 lines]";
export const BIN_PLACEHOLDER = "[binary file — no diff captured]";
export const MAX_LINES = 500;

/**
 * Filename of the persisted claim env cache (W1496; mirrors the role of
 * stride-hook.sh's .stride-env-cache, JSON format instead of shell-source).
 */
export const ENV_CACHE_FILE = ".stride-env-cache";

/**
 * (W1636) Relative path of the canonical API-response capture, mirroring the
 * bash hook's `RESPONSE_FILE="$PROJECT_DIR/.stride/.last-api-response.json"`.
 * The full untruncated /complete (or /claim) response is written here so the
 * after_goal detection reads it in preference to the harness-truncatable tool
 * stdout. Repo-root-relative, so it is excluded from `changed_files` by an
 * exact-equality match in `ROOT_ARTIFACTS`.
 */
export const CANONICAL_RESPONSE_FILE = ".stride/.last-api-response.json";

/**
 * (W1636) Typed result of {@link getAfterGoalStatus}: whether the just-completed
 * task armed an after_goal hook (`armed`), the parent goal id to PATCH
 * (`goalId`, `null` when the server omits it), and the hook's env map (`env`).
 */
export interface AfterGoalStatus {
  armed: boolean;
  goalId: string | null;
  env: Record<string, string>;
}

/**
 * Capture the per-file diff snapshot.
 *
 * @param $ - Bun shell helper (from the plugin's `Plugin` context)
 * @param cwd - Project directory to run git commands in
 * @param base - Base ref to diff against (typically `TASK_BASE_REF`)
 * @returns JSON-serializable array of `{path, diff}` entries
 */
export async function captureChangedFiles(
  $: ShellHelper,
  cwd: string,
  base: string | undefined,
): Promise<ChangedFile[]> {
  // Resolve base ref — fall back to HEAD~1 if missing or unresolvable
  const resolvedBase = await resolveBase($, cwd, base);
  if (resolvedBase === null) return [];

  // Tracked: committed + staged + unstaged changes (Option D — no `..HEAD`)
  const tracked = await runGit($, cwd, [
    "diff",
    "--name-only",
    resolvedBase,
  ]);
  // Untracked: not covered by .gitignore
  const untracked = await runGit($, cwd, [
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);

  const trackedList = splitLines(tracked);
  const untrackedSet = new Set(splitLines(untracked));

  // (D67) Exclude the hook's OWN root bookkeeping artifacts from the snapshot:
  // .stride-diff-upload-state, .stride-changed-files.json, and (W1496)
  // .stride-env-cache otherwise pass both the tracked-diff and
  // untracked-not-gitignored nets and leak into a task's changed_files. git
  // emits repo-root-relative paths, so an exact-equality match is anchored to
  // the repo root — a same-named file in a subdirectory (e.g.
  // sub/.stride-diff-upload-state) keeps its path prefix and is captured.
  const ROOT_ARTIFACTS = new Set([
    ".stride-diff-upload-state",
    ".stride-changed-files.json",
    ENV_CACHE_FILE,
    // (W1636) The canonical API-response capture is hook bookkeeping, never
    // task output. This is an exact-match exclusion (git emits repo-root-
    // relative paths), so it removes precisely `.stride/.last-api-response.json`
    // — narrower than the bash hook's whole-`.stride/`-directory prefix exclude;
    // a future sibling file under `.stride/` would need its own entry here.
    CANONICAL_RESPONSE_FILE,
    // (W2150) The loop-state record is the sibling this comment anticipated:
    // hook bookkeeping under .stride/, never task output, and it needs its own
    // exact-match entry for the same reason.
    LOOP_STATE_FILE,
  ]);

  // Dedupe by path (tracked and untracked should not overlap, but the Set
  // makes the single-entry-per-path invariant explicit)
  const allPaths: string[] = [];
  const seen = new Set<string>();
  for (const p of [...trackedList, ...untrackedSet]) {
    // (W2150) `.stride/` is skipped by PREFIX, not by exact match: the
    // loop-state writer's staging file `.stride/loop-state.<pid>.<ts>.<rand>.tmp`
    // is normally renamed or unlinked, but an orphan left by a killed process
    // would otherwise pass the untracked net and be uploaded. This matches
    // stride-pi's changed-files.ts and the shell hook, and covers every future
    // sibling under the runtime directory without a new entry each time.
    if (p && !p.startsWith(".stride/") && !ROOT_ARTIFACTS.has(p) && !seen.has(p)) {
      seen.add(p);
      allPaths.push(p);
    }
  }

  if (allPaths.length === 0) return [];

  // numstat for tracked changes — detects binaries via the `- -` marker
  const numstat = await runGit($, cwd, [
    "diff",
    "--numstat",
    resolvedBase,
  ]);
  const trackedBinaries = parseBinaryPaths(numstat);

  const result: ChangedFile[] = [];
  for (const file of allPaths) {
    const isUntracked = untrackedSet.has(file);
    let diffText = "";
    let isBinary = false;

    if (isUntracked) {
      // Synthesize a new-file unified patch via `git diff --no-index /dev/null <file>`
      // Exit code 1 is expected (files differ); --no-color guards against
      // pager/color config bleeding in.
      diffText = await runGit($, cwd, [
        "diff",
        "--no-index",
        "--no-color",
        "/dev/null",
        file,
      ]);
      // Binary detection: --no-index emits a "Binary files ... differ" sentinel
      // anywhere in the output for binaries; sniffing it is more reliable than
      // a NUL-byte grep (which over-flags in some shells).
      if (/^Binary files .* differ$/m.test(diffText)) {
        isBinary = true;
      }
    } else {
      isBinary = trackedBinaries.has(file);
    }

    if (isBinary) {
      diffText = BIN_PLACEHOLDER;
    } else if (!isUntracked) {
      // Tracked: working-tree diff vs base (committed + staged + unstaged)
      diffText = await runGit($, cwd, ["diff", resolvedBase, "--", file]);
    }

    diffText = truncateDiff(diffText);
    result.push({ path: file, diff: diffText });
  }

  return result;
}

async function resolveBase(
  $: ShellHelper,
  cwd: string,
  base: string | undefined,
): Promise<string | null> {
  if (base) {
    const ok = await verifyRef($, cwd, base);
    if (ok) return base;
  }
  const headBack = await verifyRef($, cwd, "HEAD~1");
  return headBack ? "HEAD~1" : null;
}

/**
 * (D142) Trust guard for the snapshot base ref. `TASK_BASE_REF` is supposed to
 * be the task branch point — the commit HEAD pointed at right after the
 * `## before_doing` section finished (post-pull). A value inherited from a
 * previous task or session can predate commits that arrived via the
 * before_doing pull; diffing from it would span ANOTHER clone's completed task
 * (the D132/W1678 incident). Rules, in order:
 *   1. empty or unresolvable base                → recompute from the branch point
 *   2. base is not an ancestor of HEAD           → recompute (e.g. rebased away)
 *   3. base is a STRICT ancestor of the task branch point (unmarked only) →
 *      recompute — the range base..HEAD would include commits pulled from
 *      origin. A plain is-ancestor-of-HEAD check cannot catch this: the D132
 *      stale base WAS an ancestor of HEAD.
 * "Task branch point" = merge-base of HEAD and the origin default branch.
 * Without an origin branch there is no branch point to judge against (and no
 * cross-clone pull is possible), so the base passes through unchanged and
 * {@link captureChangedFiles} keeps its own HEAD~1 fallback. Rule 3 is gated on
 * `trusted`: a base THIS claim's post-before_doing capture wrote is the branch
 * point by construction (origin/main may legitimately have advanced past it
 * when the workflow pushes its own task commits before completing), so a marked
 * base skips rule 3. Recomputes are announced on stderr — never silently.
 * Returns the base ref to use (or `undefined` when there is nothing usable).
 */
export async function resolveSnapshotBase(
  $: ShellHelper,
  cwd: string,
  base: string | undefined,
  trusted: boolean,
): Promise<string | undefined> {
  if (!(await verifyRef($, cwd, "HEAD"))) return base;

  // Resolve the origin default branch → its merge-base with HEAD is the branch point.
  let remoteHead = (
    await runGit($, cwd, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])
  ).trim();
  if (remoteHead.startsWith("refs/remotes/")) {
    remoteHead = remoteHead.slice("refs/remotes/".length);
  }
  if (!remoteHead) {
    for (const cand of ["origin/main", "origin/master"]) {
      if (await verifyRef($, cwd, cand)) {
        remoteHead = cand;
        break;
      }
    }
  }
  if (!remoteHead) return base;
  const branchPoint = (
    await runGit($, cwd, ["merge-base", "HEAD", remoteHead])
  ).trim();
  if (!branchPoint) return base;

  let reason = "";
  const baseSha = base
    ? (await runGit($, cwd, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`])).trim()
    : "";
  if (!base || !baseSha) {
    reason = "empty or unresolvable";
  } else if (!(await isAncestor($, cwd, baseSha, "HEAD"))) {
    reason = "not an ancestor of HEAD";
  } else if (
    !trusted &&
    baseSha !== branchPoint &&
    (await isAncestor($, cwd, baseSha, branchPoint))
  ) {
    reason =
      "older than the task branch point, so the diff would span commits pulled from origin";
  }
  if (!reason) return base;

  console.error(
    `stride-hook: TASK_BASE_REF ${base || "<empty>"} is not trustworthy (${reason}); recomputed the snapshot base from the task branch point: ${branchPoint}`,
  );
  return branchPoint;
}

/**
 * `git merge-base --is-ancestor A B` — true when A is an ancestor of (or equal
 * to) B. Any git failure (missing ref, not a repo) is treated as "not an
 * ancestor".
 */
async function isAncestor(
  $: ShellHelper,
  cwd: string,
  a: string,
  b: string,
): Promise<boolean> {
  try {
    const result = await $`git merge-base --is-ancestor ${a} ${b}`
      .cwd(cwd)
      .quiet()
      .nothrow();
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

async function verifyRef(
  $: ShellHelper,
  cwd: string,
  ref: string,
): Promise<boolean> {
  try {
    await $`git rev-parse --verify ${ref}`.cwd(cwd).quiet();
    return true;
  } catch {
    return false;
  }
}

async function runGit(
  $: ShellHelper,
  cwd: string,
  args: string[],
): Promise<string> {
  try {
    const result = await $`git ${args}`.cwd(cwd).quiet().nothrow();
    return result.stdout.toString();
  } catch {
    return "";
  }
}

function splitLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function parseBinaryPaths(numstat: string): Set<string> {
  const out = new Set<string>();
  for (const line of numstat.split("\n")) {
    // Format: "added\tdeleted\tpath" — binary files emit "- - <path>"
    const cols = line.split("\t");
    if (cols.length >= 3 && cols[0] === "-" && cols[1] === "-") {
      out.add(cols.slice(2).join("\t"));
    }
  }
  return out;
}

function truncateDiff(diff: string): string {
  if (!diff) return diff;
  const lines = diff.split("\n");
  // Match bash semantic: line_count = (#diff - #_no_nl + 1); if > MAX_LINES, truncate
  // In JS terms: if the diff has more than MAX_LINES newline-separated entries, truncate
  if (lines.length <= MAX_LINES) return diff;
  return lines.slice(0, MAX_LINES - 1).join("\n") + "\n" + TRUNC_MARKER;
}

// --- PUT helpers (G162 + G174 ports; D54 credential resolution) ---
//
// extractApiBase / extractToken pull the Stride API URL and Bearer token out of
// the agent's intercepted completion command — same regex shape as the bash
// hook's grep -oE pipeline. resolveStrideApiUrl / resolveStrideApiToken (the
// D54 port) prefer $projectDir/.stride_auth.md as the primary source so the
// upload still works when the completion curl used shell variables
// ($STRIDE_API_URL / $STRIDE_API_TOKEN), falling back to the command literals
// for back-compat.
const API_BASE_RE = /https?:\/\/[A-Za-z0-9._-]+(?::[0-9]+)?/;
const TOKEN_RE = /Bearer +([A-Za-z0-9._+/=-]+)/;

export function extractApiBase(command: string): string | null {
  if (!command) return null;
  const match = command.match(API_BASE_RE);
  return match ? match[0] : null;
}

export function extractToken(command: string): string | null {
  if (!command) return null;
  const match = command.match(TOKEN_RE);
  return match ? match[1] : null;
}

/** Filename of the Stride auth file, the primary credential source (D54). */
export const AUTH_FILE = ".stride_auth.md";

// URL pattern for the `.stride_auth.md` `**API URL:**` line — mirrors the bash
// hook's `grep -oE 'https?://[A-Za-z0-9._:/-]+'` (host:port + path chars; stops
// at the closing backtick, which is not in the character class).
const AUTH_URL_RE = /https?:\/\/[A-Za-z0-9._:/-]+/;

/**
 * Read the lines of `$projectDir/.stride_auth.md`, or `null` if the file is
 * absent or unreadable. Best-effort — never throws.
 */
async function readAuthFileLines(projectDir: string): Promise<string[] | null> {
  try {
    const file = Bun.file(`${projectDir}/${AUTH_FILE}`);
    if (!(await file.exists())) return null;
    return (await file.text()).split("\n");
  } catch {
    return null;
  }
}

/**
 * Resolve the Stride API base URL for the changed_files upload — D54 port of
 * `stride-hook.sh:resolve_stride_api_url`.
 *
 * Primary source: the `**API URL:** \`<url>\`` line in
 * `$projectDir/.stride_auth.md`. Falls back to a literal URL in the intercepted
 * completion `command` when the auth file is absent or has no URL line. Returns
 * `null` if neither yields a URL. Best-effort — never throws.
 */
export async function resolveStrideApiUrl(
  projectDir: string,
  command: string,
): Promise<string | null> {
  const lines = await readAuthFileLines(projectDir);
  if (lines) {
    for (const line of lines) {
      if (line.includes("**API URL:**")) {
        const match = line.match(AUTH_URL_RE);
        if (match) return match[0];
      }
    }
  }
  return extractApiBase(command);
}

/**
 * Resolve the Stride API bearer token for the changed_files upload — D54 port
 * of `stride-hook.sh:resolve_stride_api_token`.
 *
 * Primary source: the PRODUCTION `**API Token:** \`<token>\`` line in
 * `$projectDir/.stride_auth.md` — deliberately NOT the `**Local API Token:**`
 * line. The literal substring `**API Token:**` does not occur within
 * `**Local API Token:**` (no `**` immediately precedes `API` there), so a plain
 * `includes` check discriminates exactly as the bash hook's
 * `grep -E '\*\*API Token:\*\*'` does. Falls back to a literal `Bearer <token>`
 * in the intercepted `command`. Returns `null` if neither yields a token. Never
 * logs the token. Best-effort — never throws.
 */
export async function resolveStrideApiToken(
  projectDir: string,
  command: string,
): Promise<string | null> {
  const lines = await readAuthFileLines(projectDir);
  if (lines) {
    for (const line of lines) {
      if (line.includes("**API Token:**")) {
        const match = line.match(/`([^`]+)`/);
        if (match) return match[1];
      }
    }
  }
  return extractToken(command);
}

/**
 * Fire-and-forget PUT the captured snapshot to the Stride server.
 *
 * D61: the body is the transport-encoded envelope
 * `{"changed_files":{"encoding":"base64","data":"<b64>"}}` rather than the raw
 * array, so an edge request filter (WAF) does not misread a unified code diff
 * as an attack payload and silently drop the upload. The server decodes the
 * base64 back to the identical list. The base64 is single-line. If base64
 * encoding is unavailable we fall back to the raw `{"changed_files":[...]}`
 * object — never a bare top-level array, which would land at `params['_json']`
 * under Plug.Parsers, validate as `{:ok, nil}`, and persist as NULL (G174).
 *
 * Returns `null` on any prerequisite miss (no apiBase, no token, no taskId) so
 * the caller never has to gate AND can tell that no PUT was attempted (W1094:
 * a skipped PUT records no upload-state). Otherwise returns the HTTP status
 * code — `0` on a transport failure, mirroring the bash twin's `'000'`. A
 * non-2xx response and any fetch error are surfaced as a stderr warning (never
 * the token) rather than being dropped — after_doing must remain
 * blocking-but-not-fragile, so we warn rather than throw. (W1498) The fetch
 * carries an abort timeout so a hung server cannot stall the gate; an abort
 * takes the same transport-failure path as any other fetch error.
 */
export const PUT_TIMEOUT_MS = 10_000;

export async function putChangedFiles(
  apiBase: string | null,
  token: string | null,
  taskId: string | null | undefined,
  files: ChangedFile[],
): Promise<number | null> {
  if (!apiBase || !token || !taskId) return null;
  const url = `${apiBase.replace(/\/+$/, "")}/api/tasks/${taskId}/changed_files`;

  let body: string;
  try {
    const b64 = Buffer.from(JSON.stringify(files), "utf8").toString("base64");
    body = JSON.stringify({ changed_files: { encoding: "base64", data: b64 } });
  } catch {
    body = JSON.stringify({ changed_files: files });
  }

  try {
    const resp = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body,
      // (W1498) The PUT is awaited inside the blocking after_doing gate, so a
      // hung server must not hold completion hostage. Abort maps to the
      // transport-failure catch below (return 0 → self-heal retries). 10s is
      // generous enough for large diffs on slow links.
      signal: AbortSignal.timeout(PUT_TIMEOUT_MS),
    });
    if (!resp.ok) {
      // Surface a failed upload instead of dropping it silently. The diff is
      // non-fatal to completion, so we warn rather than throw.
      console.error(
        `stride-hook: changed_files upload failed (HTTP ${resp.status}) for task ${taskId}`,
      );
    }
    return resp.status;
  } catch {
    // fire-and-forget — never block completion on upload failure
    console.error(`stride-hook: changed_files upload failed for task ${taskId}`);
    return 0;
  }
}

/**
 * (W1636) GET `/api/tasks/:id/after_goal_status`, the transport twin of the
 * bash hook's `detect_after_goal_via_api`. Returns the parsed
 * {@link AfterGoalStatus} on a 2xx JSON response, or `null` for every degraded
 * path — missing credentials/task id, non-2xx, non-object body, transport
 * error, or the {@link PUT_TIMEOUT_MS} abort. Best-effort by contract: it never
 * throws, so a caller can treat a `null`/`armed: false` result as "no after_goal
 * to run" without gating. Mirrors {@link putChangedFiles}'s fail-soft handling
 * and abort timeout; unlike a mutating PUT, a failed detection is silent (no
 * stderr warning) because a missing after_goal is the common, non-noteworthy
 * case. Takes already-resolved `apiBase`/`token` (via resolveStrideApiUrl/Token)
 * — it never reads credentials or an env var itself.
 */
export async function getAfterGoalStatus(
  apiBase: string | null,
  token: string | null,
  taskId: string | null | undefined,
): Promise<AfterGoalStatus | null> {
  if (!apiBase || !token || !taskId) return null;
  const url = `${apiBase.replace(/\/+$/, "")}/api/tasks/${taskId}/after_goal_status`;

  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
      // Same abort budget as putChangedFiles — a hung server must not stall the
      // caller; an abort takes the transport-failure path (return null) below.
      signal: AbortSignal.timeout(PUT_TIMEOUT_MS),
    });
    if (!resp.ok) return null;

    const parsed: unknown = await resp.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const obj = parsed as Record<string, unknown>;

    const goalId =
      typeof obj.goal_id === "string"
        ? obj.goal_id
        : typeof obj.goal_id === "number"
          ? String(obj.goal_id)
          : null;

    const env: Record<string, string> = {};
    const rawEnv = obj.env;
    if (rawEnv && typeof rawEnv === "object" && !Array.isArray(rawEnv)) {
      for (const [key, value] of Object.entries(rawEnv)) {
        if (typeof value === "string") env[key] = value;
      }
    }

    return { armed: obj.after_goal_armed === true, goalId, env };
  } catch {
    // best-effort detection — a failed GET simply means "no after_goal known"
    return null;
  }
}

/**
 * (W1094) Record the outcome of a changed_files PUT attempt so the
 * before_review self-heal can verify it on a fresh budget. Writes ONLY the
 * task id, HTTP code, and (D142) the trust-guard-resolved snapshot base —
 * never the URL or bearer token — to `${projectDir}/.stride-diff-upload-state`.
 * The base lets the self-heal reuse the after_doing-time judgment instead of
 * re-resolving against origin refs the section's own `git push` may have moved.
 * Best-effort: a failed write must never block completion.
 */
export async function recordDiffUploadState(
  projectDir: string,
  taskId: string,
  httpCode: number,
  base?: string,
): Promise<void> {
  try {
    const baseLine = base ? `base=${base}\n` : "";
    await Bun.write(
      `${projectDir}/.stride-diff-upload-state`,
      `task_id=${taskId}\nhttp_code=${httpCode}\n${baseLine}`,
    );
  } catch {
    // best-effort — never block on a failed state write
  }
}

/**
 * (W1658) Append the terminal `unresolved=yes` marker to the diff-upload state
 * file after the before_review self-heal — the LAST upload retry — still failed
 * to land a 2xx. Additive to the `task_id` / `http_code` lines written by
 * {@link recordDiffUploadState}: a later successful PUT calls that writer, which
 * OVERWRITES the whole file and thereby self-clears this mark. Carries no URL or
 * bearer token — only the marker line. Best-effort: a failed write must never
 * block completion.
 */
export async function markDiffUploadUnresolved(
  projectDir: string,
): Promise<void> {
  const path = `${projectDir}/.stride-diff-upload-state`;
  try {
    let existing = "";
    try {
      const file = Bun.file(path);
      if (await file.exists()) existing = await file.text();
    } catch {
      existing = "";
    }
    await Bun.write(path, `${existing}unresolved=yes\n`);
  } catch {
    // best-effort — never block on a failed state write
  }
}

/**
 * (W1094) Read the recorded changed_files upload outcome, or `null` when the
 * state file is absent or unreadable (treated as "no healthy upload on
 * record"). Parses `task_id`, `http_code`, and (D142) the resolved snapshot
 * `base` lines; `base` is `undefined` on older state files that predate it.
 */
export async function readDiffUploadState(
  projectDir: string,
): Promise<{ taskId: string; httpCode: string; base?: string } | null> {
  try {
    const file = Bun.file(`${projectDir}/.stride-diff-upload-state`);
    if (!(await file.exists())) return null;
    const text = await file.text();
    let taskId = "";
    let httpCode = "";
    let base: string | undefined;
    for (const line of text.split("\n")) {
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq);
      const value = line.slice(eq + 1).trim();
      if (key === "task_id" && !taskId) taskId = value;
      else if (key === "http_code" && !httpCode) httpCode = value;
      else if (key === "base" && base === undefined) base = value;
    }
    return { taskId, httpCode, base };
  } catch {
    return null;
  }
}

/**
 * (W1496) Persist the claim env cache to `${projectDir}/.stride-env-cache` so
 * a host restart between claim and complete does not lose TASK_ID and
 * TASK_BASE_REF. Holds task metadata only — the API token is resolved from
 * .stride_auth.md and must NEVER be written here. Best-effort: a failed write
 * must never block the claim.
 */
export async function writeEnvCache(
  projectDir: string,
  env: Record<string, string>,
): Promise<void> {
  try {
    await Bun.write(
      `${projectDir}/${ENV_CACHE_FILE}`,
      JSON.stringify(env, null, 2) + "\n",
    );
  } catch {
    // best-effort — never block on a failed state write
  }
}

/**
 * (W1496) Read the persisted claim env cache, or `{}` when the file is
 * absent, unreadable, or malformed — corrupt state degrades to the
 * empty-cache behaviour, never a throw. Only string-valued entries of a
 * plain JSON object are accepted.
 */
export async function readEnvCache(
  projectDir: string,
): Promise<Record<string, string>> {
  try {
    const file = Bun.file(`${projectDir}/${ENV_CACHE_FILE}`);
    if (!(await file.exists())) return {};
    const parsed: unknown = JSON.parse(await file.text());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") env[key] = value;
    }
    return env;
  } catch {
    return {};
  }
}

/**
 * (W1496) Remove the persisted claim env cache — the after_review cleanup
 * counterpart to writeEnvCache. Missing file is the expected path.
 */
export async function clearEnvCache(projectDir: string): Promise<void> {
  try {
    await Bun.file(`${projectDir}/${ENV_CACHE_FILE}`).unlink();
  } catch {
    // File didn't exist — that's the expected path
  }
}

/**
 * (W2150) Loop-state record — the OpenCode port of stride-hook.sh's W2123
 * helpers and of the clear in its before_doing branch.
 *
 * This is a FLEET contract, not a port-local artifact: stride's
 * stride-stop-gate.sh (and its PowerShell twin) reads exactly these four keys
 * out of a shared checkout, so the shape here matches the shell writer key for
 * key and type for type. `needs_review` is the literal JSON boolean — the gate
 * tests `(.needs_review | type) == "boolean"`, so a stringified "false"
 * silently defeats terminal-state-2 detection rather than erroring.
 */
export const LOOP_STATE_FILE = ".stride/.loop-state.json";

/** The record, in the shell writer's key order. */
export interface LoopStateRecord {
  identifier: string;
  needs_review: boolean;
  completed_at: string;
  session_id: string;
}

/** Mirror of stride-hook.sh:loop_state_safe (non-empty, <=64, [A-Za-z0-9_.:-]). */
export function loopStateSafe(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 64 &&
    /^[A-Za-z0-9_.:-]+$/.test(value)
  );
}

/**
 * `date -u +%Y-%m-%dT%H:%M:%SZ`.
 *
 * toISOString() yields milliseconds; strip them with a regex rather than
 * slice(0, 19), which would silently corrupt an ISO extended-year timestamp
 * into garbage that still looks like a date.
 */
export function completedAtNow(now: Date = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * (W2150) Atomic and never fatal — the mechanics of write_loop_state. Bun.write
 * alone is NOT atomic (a reader can see a half-file), so the payload is staged
 * on a temp path inside the destination `.stride/` directory and renamed into
 * place same-filesystem. Best-effort: every failure path cleans up the temp and
 * returns false; a completion never fails because this did.
 */
export async function writeLoopState(
  projectDir: string,
  record: LoopStateRecord,
): Promise<boolean> {
  const dir = `${projectDir}/.stride`;
  const dest = `${projectDir}/${LOOP_STATE_FILE}`;
  let tmp = "";
  try {
    // A rename onto a fifo/socket/directory would "succeed" and put the record
    // where no reader looks. Refuse a non-regular destination, as the shell does.
    // lstat, not stat: statSync RESOLVES symlinks, so a link pointing at a
    // regular file passes isFile() and the rename would replace the link while
    // a plain write would truncate its target. lstat sees the link itself.
    // (W2152: mirrored from recordInjection, which hit the same weakness.)
    try {
      if (!lstatSync(dest).isFile()) {
        process.stderr.write(
          "stride: loop-state path is not a regular file; not recording\n",
        );
        return false;
      }
    } catch {
      // ENOENT — the ordinary first-write case.
    }
    mkdirSync(dir, { recursive: true });
    tmp = `${dir}/loop-state.${process.pid}.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2, 8)}.tmp`;
    // Key order and the trailing newline match the shell writer's jq object
    // literal and its `printf '%s\n'`. needs_review is written as the boolean
    // it already is — never String()'d.
    const json =
      JSON.stringify({
        identifier: record.identifier,
        needs_review: record.needs_review,
        completed_at: record.completed_at,
        session_id: record.session_id,
      }) + "\n";
    // Created 0600 rather than written-then-chmod'd: staging with Bun.write
    // and relaxing the mode afterwards leaves the payload world-readable for
    // the window in between, and a failed chmod would rename a 0644 file into
    // place. Matches the Pi twin, which passes the mode at creation time.
    writeFileSync(tmp, json, { encoding: "utf-8", mode: 0o600 });
    renameSync(tmp, dest);
    return true;
  } catch {
    try {
      if (tmp) rmSync(tmp, { force: true });
    } catch {
      // best effort
    }
    // The shell announces every failure branch, and Pi mirrors it. Without
    // this an operator sees a green completion and an absent record with no
    // explanation. Still best-effort and still non-fatal.
    try {
      process.stderr.write("stride: could not record the loop state; continuing\n");
    } catch {
      // best effort
    }
    return false;
  }
}

/**
 * (W2152) Read and validate the loop-state record from disk — the reader W2150
 * never needed, because that task only wrote.
 *
 * Null on an absent, unreadable, or non-JSON file, and on any field that fails
 * the writer's own rules: a reader that accepted a record the writer would not
 * produce would be reading something other than the fleet contract.
 * `needs_review` must be a real boolean for the same reason the writer insists
 * on one — a stringified "false" is unusable, not falsy. Never throws.
 */
export async function readLoopState(
  projectDir: string,
): Promise<LoopStateRecord | null> {
  let text: string;
  try {
    text = await Bun.file(`${projectDir}/${LOOP_STATE_FILE}`).text();
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;
  if (!loopStateSafe(rec.identifier)) return null;
  if (typeof rec.needs_review !== "boolean") return null;
  if (typeof rec.completed_at !== "string" || rec.completed_at.length === 0) return null;
  if (typeof rec.session_id !== "string" || rec.session_id.length === 0) return null;
  return {
    identifier: rec.identifier,
    needs_review: rec.needs_review,
    completed_at: rec.completed_at,
    session_id: rec.session_id,
  };
}

/**
 * (W2150) Remove the record on a claim. Unlink, not an empty write: the gate
 * treats absence as "undetermined", but a `{}` file parses and would read as a
 * record with no usable needs_review. Missing file is the expected path (same
 * shape as clearEnvCache); a clear that FAILS is announced, because a surviving
 * stale record is the dangerous direction.
 */
export async function clearLoopState(projectDir: string): Promise<void> {
  const dest = `${projectDir}/${LOOP_STATE_FILE}`;
  try {
    await Bun.file(dest).unlink();
  } catch {
    // File didn't exist — that's the expected path
  }
  try {
    if (existsSync(dest)) {
      process.stderr.write(
        `stride: could not clear the loop state at ${dest}; a stale completion record remains\n`,
      );
    }
  } catch {
    // best effort
  }
}

/**
 * (W1636) Persist the full API response to
 * `${projectDir}/.stride/.last-api-response.json` (see
 * {@link CANONICAL_RESPONSE_FILE}), the twin of the bash hook's
 * `capture_canonical_response`. The harness truncates the tool stdout the hook
 * would otherwise parse, so after_goal detection reads this untruncated file
 * first. `Bun.write` creates the missing `.stride/` parent directory. Accepts an
 * arbitrary JSON-serializable payload; best-effort — a failed write never blocks
 * the caller.
 */
export async function writeCanonicalResponse(
  projectDir: string,
  response: unknown,
): Promise<void> {
  try {
    await Bun.write(
      `${projectDir}/${CANONICAL_RESPONSE_FILE}`,
      JSON.stringify(response) + "\n",
    );
  } catch {
    // best-effort — never block on a failed capture write
  }
}

/**
 * (W1636) Read the canonical API-response capture, or `null` when the file is
 * absent, unreadable, or not valid JSON — mirroring the bash hook's
 * `read_canonical_response` validate-before-trust rule so a truncated or
 * garbage file degrades to "nothing captured" rather than throwing. Returns the
 * parsed payload verbatim (any JSON value), so the caller inspects the shape it
 * expects.
 */
export async function readCanonicalResponse(
  projectDir: string,
): Promise<unknown | null> {
  try {
    const file = Bun.file(`${projectDir}/${CANONICAL_RESPONSE_FILE}`);
    if (!(await file.exists())) return null;
    return JSON.parse(await file.text());
  } catch {
    return null;
  }
}
