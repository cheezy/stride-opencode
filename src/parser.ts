/**
 * .stride.md parser module
 *
 * Extracts hook commands from .stride.md files by parsing ## section headings
 * and ```bash code blocks. Handles CRLF/LF, missing trailing newlines,
 * comments, blank lines, and adjacent sections.
 */

export type HookName =
  | "before_doing"
  | "after_doing"
  | "before_review"
  | "after_review"
  | "after_goal";

/**
 * Parse a .stride.md file and extract commands for the given hook section.
 *
 * Finds the ## heading matching hookName, then extracts lines from the first
 * ```bash code block under that heading. Stops at the next ## heading or end
 * of file.
 *
 * @param content - Raw .stride.md file content (LF or CRLF)
 * @param hookName - The hook section to extract (e.g., "before_doing")
 * @returns Array of executable command strings (comments and blanks filtered)
 */
export function parseStrideMd(content: string, hookName: HookName): string[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  let found = false;
  let capture = false;
  const rawLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (found) break;
      const section = line.slice(3).trim();
      if (section === hookName) {
        found = true;
      }
      continue;
    }

    if (found) {
      if (line.startsWith("```bash")) {
        capture = true;
        continue;
      }
      if (line.startsWith("```")) {
        if (capture) break;
        continue;
      }
      if (capture) {
        rawLines.push(line);
      }
    }
  }

  return buildCommandList(rawLines);
}

/**
 * Filter and clean raw command lines from a code block.
 *
 * Removes blank lines, comment lines (starting with #), and trims whitespace.
 *
 * @param lines - Raw lines from a ```bash code block
 * @returns Cleaned array of executable commands
 */
export function buildCommandList(lines: string[]): string[] {
  return lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}
