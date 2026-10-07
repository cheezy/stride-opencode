import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// --- W2313: break-it evidence for new and changed tests ---
//
// stride-workflow Step 4 tells the implementer to break each test the diff
// adds or changes, watch it fail, restore and watch it pass; Step 6 sends the
// results to the reviewer as a `break_it` block; review step 4 of
// agents/task-reviewer.md audits them. These tests pin the three edge cases
// that decide when an entry is owed, and hold the reviewer's JSON block shape
// still, since the rule adds evidence without adding a key.
//
// Every pin asserts its phrase occurs exactly ONCE in the slice it reads, so a
// break at the one site that carries the rule always turns the test red.

const ROOT = join(import.meta.dir, "..");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");

const SKILL = read("skills", "stride-workflow", "SKILL.md");
const AGENT = read("agents", "task-reviewer.md");

function slice(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  if (from < 0) throw new Error(`"${start}" not found`);
  const to = text.indexOf(end, from + start.length);
  if (to < 0) throw new Error(`"${end}" not found after "${start}"`);
  return text.slice(from, to);
}

function occurrences(text: string, phrase: string): number {
  return text.split(phrase).length - 1;
}

const STEP4 = slice(SKILL, "### Break-it evidence for new and changed tests", "## Step 5");
const STEP6 = slice(SKILL, "## Step 6: Code Review", "<!-- canon:review-round-cap");
const REVIEWER_INPUTS = slice(AGENT, "**`break_it` may also arrive", "When reviewing code changes for a Stride task");
const REVIEW_STEP4 = slice(AGENT, "4. **Testing Strategy Alignment**", "**Behaviour/Test Matrix Verification**");

describe("a diff with no new or changed tests owes no entries", () => {
  it("Step 4 says such a diff has no entries", () => {
    expect(occurrences(STEP4, "A diff with no new or changed test has no entries at all.")).toBe(1);
  });

  it("Step 6 leaves the break_it block out for such a diff", () => {
    expect(occurrences(STEP6, "**When it adds or changes none, leave the block out**")).toBe(1);
  });

  it("the reviewer reads an absent block as no entries", () => {
    expect(occurrences(REVIEWER_INPUTS, "absent means there are no entries")).toBe(1);
  });
});

describe("a formatting-only test change owes no entry", () => {
  it("Step 4 exempts a whitespace, rewrapping or comment edit", () => {
    expect(occurrences(STEP4, "An edit that is purely whitespace, rewrapping or comments")).toBe(1);
  });

  it("review step 4 does not raise a missing entry for one", () => {
    expect(occurrences(REVIEW_STEP4, "one changed only in whitespace, wrapping or comments needs none")).toBe(1);
  });
});

describe("a test that cannot be broken inside the repository carries not_broken_reason", () => {
  it("Step 4 records the outside effect instead of skipping the test", () => {
    expect(occurrences(STEP4, "a one-line `not_broken_reason` names the outside effect")).toBe(1);
  });

  it("review step 4 flags a reason that names no outside effect", () => {
    expect(occurrences(REVIEW_STEP4, "a `not_broken_reason` that names no effect outside the repository")).toBe(1);
  });
});

describe("the reviewer's JSON block keeps its keys and schema_version", () => {
  const at = AGENT.indexOf("**Worked example**");
  const open = AGENT.indexOf("```json\n", at) + "```json\n".length;
  const close = AGENT.indexOf("\n```", open);
  const example = JSON.parse(AGENT.slice(open, close));

  it("the worked example still declares schema_version 1.7", () => {
    expect(at).toBeGreaterThan(0);
    expect(example.schema_version).toBe("1.7");
  });

  it("the worked example carries exactly the existing top-level keys", () => {
    expect(Object.keys(example).sort()).toEqual([
      "acceptance_criteria",
      "behaviour_test_matrix",
      "issue_counts",
      "issues",
      "patterns",
      "pitfalls",
      "project_checks",
      "schema_version",
      "security_considerations",
      "status",
      "summary",
      "testing_strategy",
    ]);
  });

  it("the field reference still pins schema_version to 1.7", () => {
    expect(occurrences(AGENT, '`schema_version`: string. Always `"1.7"`')).toBe(1);
  });

  it("review step 4's break-it check says it adds no key", () => {
    expect(
      occurrences(REVIEW_STEP4, "This adds no key to the JSON block and leaves `schema_version` unchanged."),
    ).toBe(1);
  });
});
