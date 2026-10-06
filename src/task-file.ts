/**
 * (W2300) A copy of the claimed task, kept at `.stride/.task-<stem>.json` — the
 * OpenCode port of stride W2248.
 *
 * After a claim, the plugin saves the task exactly as the server returned it,
 * so a later workflow step can read the task's fields from disk rather than
 * have them retyped. A copy made by the plugin cannot drift from the server's
 * record; a paraphrased copy can. This module only writes and removes the
 * file — no skill or agent in this port reads it yet.
 *
 * Two rules keep the file safe to have on disk:
 *
 * - Its NAME is never built from free text. The stem is the identifier only
 *   when the whole string is 1-64 characters of `[A-Za-z0-9_-]`; otherwise the
 *   non-negative integer id; otherwise no file at all. Nothing that contains a
 *   separator or a dot can reach the path, so the file cannot land outside
 *   `.stride/`.
 * - Its CONTENT is the response's `data` object and nothing else: no wrapper,
 *   no added keys, and never the auth header or token. Readers treat what is in
 *   it as data, because a task's text is authored by whoever created the task.
 *
 * Every function here is best-effort. A claim has already succeeded by the
 * time this runs, and a completion has already been accepted, so no failure in
 * this module may surface as an exception.
 *
 * This module deliberately imports nothing from ./index (no import cycle).
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

/**
 * A usable identifier stem. In JavaScript, `$` without the `m` flag anchors at
 * the very end of the input — unlike PCRE/Ruby `$`, it does NOT also match
 * before a trailing newline — so `"W1\n"` is rejected. A test pins that.
 */
export const TASK_FILE_IDENTIFIER = /^[A-Za-z0-9_-]{1,64}$/;

/** A string-typed numeric id, the last fallback (mirrors the shell's rule). */
export const TASK_FILE_STRING_ID = /^[0-9]{1,20}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The file stem for a task's data object, or null when none is safe.
 *
 * Order: an identifier that passes {@link TASK_FILE_IDENTIFIER} in full; else a
 * non-negative safe integer `id`; else a string `id` of 1-20 digits; else null.
 * `Number.isSafeInteger` keeps out `1.5`, `NaN`, and values like `1e21` whose
 * `String()` form is not a plain digit run.
 */
export function taskFileStem(data: unknown): string | null {
  if (!isPlainObject(data)) return null;
  const identifier = data.identifier;
  if (typeof identifier === "string" && TASK_FILE_IDENTIFIER.test(identifier)) {
    return identifier;
  }
  const id = data.id;
  if (typeof id === "number" && Number.isSafeInteger(id) && id >= 0) {
    return String(id);
  }
  if (typeof id === "string" && TASK_FILE_STRING_ID.test(id)) {
    return id;
  }
  return null;
}

/** Absolute path of the task file for a stem that {@link taskFileStem} produced. */
export function taskFilePath(projectDir: string, stem: string): string {
  return `${projectDir}/.stride/.task-${stem}.json`;
}

function warn(message: string): void {
  try {
    process.stderr.write(`stride: ${message}\n`);
  } catch {
    // best effort
  }
}

/**
 * Save a claimed task's data object to `.stride/.task-<stem>.json`.
 *
 * Atomic: the JSON is staged in a temp file inside `.stride/` (same filesystem)
 * and renamed over the destination, so a reader sees either the old file or
 * the new one, never a partial write. The temp file is created mode 0600 and
 * removed on every failure path. A destination that exists but is not a regular
 * file (a directory, fifo or symlink) is refused rather than written through.
 *
 * Serialised compactly with a trailing newline, the same bytes `jq -c` gives
 * the shell twin. Ids above 2^53 would lose precision in a JSON.parse round
 * trip; Stride task ids are far below that.
 *
 * `rename` exists only so a test can make the final rename fail after the temp
 * file has been written; production callers never pass it.
 *
 * @returns the stem written, or null when nothing was written. Never throws.
 */
export async function writeTaskFile(
  projectDir: string,
  data: Record<string, unknown>,
  rename: (from: string, to: string) => void = renameSync,
): Promise<string | null> {
  let tmp = "";
  try {
    const stem = taskFileStem(data);
    if (!stem) {
      warn("no usable file name for the claimed task (identifier and id both rejected); skipping the task file");
      return null;
    }
    const dir = `${projectDir}/.stride`;
    const dest = taskFilePath(projectDir, stem);
    // lstat, not stat: a symlink must be judged as itself, not by its target.
    try {
      if (!lstatSync(dest).isFile()) {
        warn("something other than a plain file sits at the task-file destination; leaving it alone");
        return null;
      }
    } catch {
      // ENOENT — the ordinary first write for this task.
    }
    mkdirSync(dir, { recursive: true });
    tmp = `${dir}/task-file.${process.pid}.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2, 8)}.tmp`;
    writeFileSync(tmp, JSON.stringify(data) + "\n", {
      encoding: "utf-8",
      mode: 0o600,
    });
    rename(tmp, dest);
    return stem;
  } catch {
    try {
      if (tmp) rmSync(tmp, { force: true });
    } catch {
      // best effort
    }
    warn("could not save the claimed task file; the claim is unaffected");
    return null;
  }
}

/**
 * Delete the task file for a completed task's data object. A missing file is
 * the quiet, expected case. Only a regular file or a symlink is unlinked —
 * never anything recursive, so a directory at that path is left in place. A
 * file that is still there afterwards is announced. Never throws.
 */
export async function removeTaskFile(
  projectDir: string,
  data: unknown,
): Promise<void> {
  try {
    const stem = taskFileStem(data);
    if (!stem) return;
    const dest = taskFilePath(projectDir, stem);
    let removable = false;
    try {
      const st = lstatSync(dest);
      removable = st.isFile() || st.isSymbolicLink();
    } catch {
      return; // nothing there
    }
    if (removable) unlinkSync(dest);
    if (existsSync(dest)) {
      warn(`the task file for ${stem} could not be removed after completion`);
    }
  } catch {
    warn("could not remove the completed task's file; continuing");
  }
}
