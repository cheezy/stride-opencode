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
 * Shell helper interface — narrowed enough that we can accept either Bun's
 * global `$` (in tests) or the plugin context's `$` (in production). Both
 * support the tagged-template shell-call pattern with `.cwd()`, `.quiet()`,
 * `.nothrow()`, and a `.stdout: Buffer` result.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ShellHelper = any;

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

  // Dedupe by path (tracked and untracked should not overlap, but the Set
  // makes the single-entry-per-path invariant explicit)
  const allPaths: string[] = [];
  const seen = new Set<string>();
  for (const p of [...trackedList, ...untrackedSet]) {
    if (p && !seen.has(p)) {
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
