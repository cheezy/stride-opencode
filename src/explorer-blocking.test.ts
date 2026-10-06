import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// --- W2304: the explorer call blocks, so there is nothing to overlap ---
//
// Upstream stride lets its main agent read key files while a background
// explorer runs. OpenCode's `task` tool returns only once the subagent has
// finished (opencode 1.16.2), so this port says so instead of carrying that
// rule. These tests pin the decision at both explorer dispatch sites, and pin
// that neither site sneaks the overlap rule back in, or presents several tool
// calls in one message as if they were background dispatch.

const SKILLS = join(import.meta.dir, "..", "skills");

function section(file: string, start: string, end: string): string {
  const text = readFileSync(join(SKILLS, file), "utf8");
  const from = text.indexOf(start);
  if (from < 0) throw new Error(`"${start}" not found in ${file}`);
  const to = text.indexOf(end, from + start.length);
  if (to < 0) throw new Error(`"${end}" not found after "${start}" in ${file}`);
  return text.slice(from, to);
}

const BRANCH_C = section(
  join("stride-workflow", "SKILL.md"),
  "### Branch C",
  "## Step 4",
);
const PHASE_1 = section(
  join("stride-subagent-workflow", "SKILL.md"),
  "## Phase 1",
  "## Phase 2",
);
const SITES: Array<[string, string]> = [
  ["stride-workflow Step 3 Branch C", BRANCH_C],
  ["stride-subagent-workflow Phase 1", PHASE_1],
];

function versionChecked(text: string): string | undefined {
  return text.match(/opencode (\d+\.\d+\.\d+)/)?.[1];
}

describe("explorer dispatch sites disclose that the task call blocks", () => {
  for (const [name, text] of SITES) {
    it(`${name} says there is nothing to overlap`, () => {
      expect(text).toContain("nothing to overlap");
    });

    it(`${name} names the OpenCode version the behaviour was checked against`, () => {
      expect(versionChecked(text)).toBeDefined();
    });

    it(`${name} does not carry the read-while-exploring rule`, () => {
      expect(text).not.toMatch(/edit no file until/i);
      expect(text).not.toMatch(/read the `?key_files`? and draft/i);
      expect(text).not.toMatch(/run_in_background/);
    });

    it(`${name} does not treat several tool calls in one message as background dispatch`, () => {
      expect(text).not.toMatch(/(same|one|single) message/i);
    });
  }

  it("both sites cite the same OpenCode version", () => {
    expect(versionChecked(BRANCH_C)).toBe(versionChecked(PHASE_1));
  });

  it("Branch C cites the source file and the experimental background flag", () => {
    expect(BRANCH_C).toContain("packages/opencode/src/tool/task.ts");
    expect(BRANCH_C).toContain("OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true");
  });

  it("Phase 1 points back to Branch C for the source and the reason", () => {
    expect(PHASE_1).toContain("`stride-workflow` Step 3 Branch C names the source and the reason");
  });
});
