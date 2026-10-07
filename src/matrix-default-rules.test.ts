import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// --- W2309: a behaviour_test_matrix by default at creation ---
//
// stride-creating-tasks, stride-creating-goals (every nested task) and
// agents/task-decomposer.md (every child task) author a seven-category matrix
// by default for a task with testable behaviour. These are markdown rules with
// no executable behaviour, so these tests pin the wording that carries each
// rule on all three authoring surfaces, so that deleting one turns the suite
// red instead of passing silently.
//
// Every pin asserts its phrase occurs exactly ONCE in the slice it reads, so a
// break at the one site that carries the rule always turns the test red.

const ROOT = join(import.meta.dir, "..");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");

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

const TASKS_SKILL = read("skills", "stride-creating-tasks", "SKILL.md");
const GOALS_SKILL = read("skills", "stride-creating-goals", "SKILL.md");
const DECOMPOSER = read("agents", "task-decomposer.md");

const TASKS = slice(TASKS_SKILL, "### behaviour_test_matrix", "### security_considerations");
const GOALS = slice(
  GOALS_SKILL,
  "Each nested task takes the same `behaviour_test_matrix` default",
  "**Minimal nested tasks fail",
);
const STEP5 = slice(DECOMPOSER, "### Step 5: Full Specification per Task", "### Step 6: Output Assembly");
const EXAMPLE = slice(DECOMPOSER, "## Example: Goal Decomposed into Tasks", "## Important Constraints");

const SURFACES: Array<[string, string]> = [
  ["stride-creating-tasks", TASKS],
  ["stride-creating-goals", GOALS],
  ["task-decomposer Step 5", STEP5],
];

describe("the matrix is authored by default for a testable task", () => {
  it("the creating-tasks checklist calls it expected by default", () => {
    expect(occurrences(TASKS_SKILL, "`behaviour_test_matrix` - **expected by default**")).toBe(1);
  });

  // Each surface words the trigger for its own subject (the task, a nested
  // task, a child task), so each is pinned by its own sentence.
  const TRIGGERS: Array<[string, string, string]> = [
    ["stride-creating-tasks", TASKS, "As soon as the task's `testing_strategy` lists a unit or integration test"],
    ["stride-creating-goals", GOALS, "Whenever a nested task's `testing_strategy` lists a unit or integration test"],
    ["task-decomposer Step 5", STEP5, "whenever the child's `testing_strategy` lists a unit or integration test"],
  ];

  for (const [name, text, phrase] of TRIGGERS) {
    it(`${name} triggers on a unit or integration test`, () => {
      expect(occurrences(text, phrase)).toBe(1);
    });
  }
});

describe("a category that does not apply is waived, never padded", () => {
  for (const [name, text] of SURFACES) {
    it(`${name} waives the row instead of dropping the field`, () => {
      expect(occurrences(text, "is a row to waive, not a reason to drop")).toBe(1);
    });

    it(`${name} forbids filler rows`, () => {
      expect(occurrences(text, "filler row")).toBe(1);
    });
  }
});

describe("a manual-only testing_strategy gets manual rows when it exercises behaviour", () => {
  for (const [name, text] of SURFACES) {
    it(`${name} names manual_tests entries in manual rows`, () => {
      expect(occurrences(text, "`type: \"manual\"` rows")).toBe(1);
    });
  }
});

describe("a task with no testable behaviour omits the matrix and says why", () => {
  for (const [name, text] of SURFACES) {
    it(`${name} gives the one-sentence description example`, () => {
      expect(
        occurrences(text, "`No behaviour_test_matrix: configuration-only change, nothing testable.`"),
      ).toBe(1);
    });
  }
});

describe("the server rules are restated unchanged", () => {
  for (const [name, text] of SURFACES) {
    it(`${name} keeps a partial matrix rejected with a 422`, () => {
      expect(occurrences(text, "A partial matrix is still rejected with a 422")).toBe(1);
    });
  }
});

describe("row test names come from testing_strategy, which the matrix never replaces", () => {
  for (const [name, text] of SURFACES) {
    it(`${name} ties each row's test_name to testing_strategy`, () => {
      expect(occurrences(text, "Every non-waived row's `test_name` must name a test")).toBe(1);
    });
  }
});

describe("row text never carries a secret or where one is kept", () => {
  it("stride-creating-tasks bans credential locations in row text", () => {
    expect(occurrences(TASKS, "and never name the place one is kept")).toBe(1);
  });

  it("stride-creating-goals bans credential locations in row text", () => {
    expect(occurrences(GOALS, "and never name the place one is kept")).toBe(1);
  });

  it("the decomposer bans credential locations in row text", () => {
    expect(occurrences(STEP5, "nor say where one is kept")).toBe(1);
  });

  it("the decomposer never copies a credential-shaped string into a row", () => {
    expect(occurrences(STEP5, "any credential-shaped string seen there stays out of every row")).toBe(1);
  });
});

describe("the decomposer's worked example says it leaves the matrix out", () => {
  it("states the omission is for length", () => {
    expect(
      occurrences(EXAMPLE, "The example leaves each task's `behaviour_test_matrix` out to keep it short."),
    ).toBe(1);
  });
});
