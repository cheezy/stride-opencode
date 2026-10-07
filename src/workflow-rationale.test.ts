import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// --- W2306: rationale lives in docs/, rules stay in the skill ---
//
// The background behind several stride-workflow rules was moved out of the
// skill into docs/orchestrator-rationale.md, leaving a one-sentence pointer at
// each site. These tests pin the two halves of that split: every pointer names
// a section that exists (and every section is pointed at), and the rule each
// moved paragraph sat beside is still stated in the skill itself, because an
// installed agent cannot be relied on to have the doc.

const ROOT = join(import.meta.dir, "..");
const SKILL = readFileSync(
  join(ROOT, "skills", "stride-workflow", "SKILL.md"),
  "utf8",
);
const DOC = readFileSync(join(ROOT, "docs", "orchestrator-rationale.md"), "utf8");

const POINTER = "`docs/orchestrator-rationale.md` § ";
const HEADINGS = [...DOC.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());

function pointerTails(text: string): string[] {
  const tails: string[] = [];
  let at = text.indexOf(POINTER);
  while (at >= 0) {
    const start = at + POINTER.length;
    tails.push(text.slice(start, text.indexOf("\n", start)));
    at = text.indexOf(POINTER, start);
  }
  return tails;
}

describe("stride-workflow pointers into docs/orchestrator-rationale.md", () => {
  it("the doc has sections to point at", () => {
    expect(HEADINGS.length).toBeGreaterThan(0);
  });

  it("every pointer names an existing section", () => {
    const tails = pointerTails(SKILL);
    expect(tails.length).toBeGreaterThan(0);
    for (const tail of tails) {
      const named = HEADINGS.find((h) => tail.startsWith(h));
      expect(named, `pointer to a missing section: ${tail}`).toBeDefined();
    }
  });

  it("every section is reached from at least one pointer", () => {
    for (const heading of HEADINGS) {
      expect(SKILL.includes(POINTER + heading), `no pointer to: ${heading}`).toBe(
        true,
      );
    }
  });

  it("the doc carries no canon anchor of its own", () => {
    expect(DOC.includes("<!-- canon:")).toBe(false);
  });
});

describe("rules that sat beside the moved reasons stay in the skill", () => {
  const RULES: Array<[string, string]> = [
    ["Plan and Review read the matrix column", "**Read the column; do not re-derive the condition here.**"],
    ["Step 0 says the .gitignore notice once", "**Say it here or not at all**"],
    ["re-check .exploratory/ when the extension is present", "**Check for `.exploratory/` whenever the extension is present, not only on Stride's first install.**"],
    ["already-committed artifacts need git rm --cached", "it also needs `git rm --cached`"],
    ["never edit the operator's .gitignore", "never edit their `.gitignore` yourself"],
    ["the review cap is followed, not checked", "**prose you follow, never something this port evaluates**"],
    ["the canon check reads the anchor only", "**It tests the anchor, never the sentence.**"],
    ["a blocked review is defined by action", "**Leave the task claimed, do not send the completion PATCH, and report to the human in the session**"],
    ["dispatch_count limit (1)", "**Use the pair to see that a review phase ran long; never to conclude it was the costlier of two.**"],
    ["dispatch_count limit (2)", "**`duration_ms / dispatch_count` is not a per-round figure"],
    ["dispatch_count limit (3)", "**Absence of a cost figure is not evidence of absent cost.**"],
    ["dispatch_count limit (4)", "**When aggregating, report the covered subset and its size instead of filling absences.**"],
    ["dispatch_count limit (5)", "**never read a cap breach out of `dispatch_count` alone**"],
    ["dispatch_count limit (6)", "has to guard for a non-integer itself"],
    ["after_goal detection runs the section at most once", "the section runs at most once"],
  ];

  for (const [name, rule] of RULES) {
    it(name, () => {
      expect(SKILL.includes(rule), `missing from SKILL.md: ${rule}`).toBe(true);
    });
  }
});
