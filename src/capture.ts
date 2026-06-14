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

export interface ChangedFile {
  path: string;
  diff: string;
}

export const TRUNC_MARKER = "[diff truncated at 500 lines]";
export const BIN_PLACEHOLDER = "[binary file — no diff captured]";
export const MAX_LINES = 500;

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
  // .stride-diff-upload-state and .stride-changed-files.json otherwise pass both
  // the tracked-diff and untracked-not-gitignored nets and leak into a task's
  // changed_files. git emits repo-root-relative paths, so an exact-equality
  // match is anchored to the repo root — a same-named file in a subdirectory
  // (e.g. sub/.stride-diff-upload-state) keeps its path prefix and is captured.
  const ROOT_ARTIFACTS = new Set([
    ".stride-diff-upload-state",
    ".stride-changed-files.json",
  ]);

  // Dedupe by path (tracked and untracked should not overlap, but the Set
  // makes the single-entry-per-path invariant explicit)
  const allPaths: string[] = [];
  const seen = new Set<string>();
  for (const p of [...trackedList, ...untrackedSet]) {
    if (p && !ROOT_ARTIFACTS.has(p) && !seen.has(p)) {
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
 * blocking-but-not-fragile, so we warn rather than throw.
 */
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
 * (W1094) Record the outcome of a changed_files PUT attempt so the
 * before_review self-heal can verify it on a fresh budget. Writes ONLY the
 * task id and HTTP code — never the URL or bearer token — to
 * `${projectDir}/.stride-diff-upload-state`. Best-effort: a failed write must
 * never block completion.
 */
export async function recordDiffUploadState(
  projectDir: string,
  taskId: string,
  httpCode: number,
): Promise<void> {
  try {
    await Bun.write(
      `${projectDir}/.stride-diff-upload-state`,
      `task_id=${taskId}\nhttp_code=${httpCode}\n`,
    );
  } catch {
    // best-effort — never block on a failed state write
  }
}

/**
 * (W1094) Read the recorded changed_files upload outcome, or `null` when the
 * state file is absent or unreadable (treated as "no healthy upload on
 * record"). Parses only `task_id` and `http_code` lines.
 */
export async function readDiffUploadState(
  projectDir: string,
): Promise<{ taskId: string; httpCode: string } | null> {
  try {
    const file = Bun.file(`${projectDir}/.stride-diff-upload-state`);
    if (!(await file.exists())) return null;
    const text = await file.text();
    let taskId = "";
    let httpCode = "";
    for (const line of text.split("\n")) {
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq);
      const value = line.slice(eq + 1).trim();
      if (key === "task_id" && !taskId) taskId = value;
      else if (key === "http_code" && !httpCode) httpCode = value;
    }
    return { taskId, httpCode };
  } catch {
    return null;
  }
}
