import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// --- W2310: the cross-field consistency pass ---
//
// agents/task-enricher.md (after its 18-item checklist) and
// agents/task-decomposer.md (Step 7, every child task) both run six checks that
// compare a task's fields with each other, and the three creating/enriching
// skills point at the pass for tasks written without those agents. These are
// markdown rules with no executable behaviour, so these tests pin the wording
// that carries each rule, so that deleting one turns the suite red instead of
// passing silently.
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

const ENRICHER_FILE = read("agents", "task-enricher.md");
const DECOMPOSER_FILE = read("agents", "task-decomposer.md");
const TASKS_SKILL = read("skills", "stride-creating-tasks", "SKILL.md");
const GOALS_SKILL = read("skills", "stride-creating-goals", "SKILL.md");
const ENRICHING_SKILL = read("skills", "stride-enriching-tasks", "SKILL.md");

const ENRICHER = slice(
  ENRICHER_FILE,
  "### Cross-Field Consistency Pass (after the checklist)",
  "## Handling Defect Tasks",
);
const DECOMPOSER = slice(
  DECOMPOSER_FILE,
  "### Step 7: Cross-Field Consistency Pass per Child Task",
  "## Task Sizing Heuristics",
);

const PASSES: Array<[string, string]> = [
  ["task-enricher", ENRICHER],
  ["task-decomposer Step 7", DECOMPOSER],
];

const CHECK_TITLES = [
  "1. **Verification scope.**",
  "2. **No contradiction.**",
  "3. **Prescribed patterns tested.**",
  "4. **Precedence stated.**",
  "5. **One line per criterion.**",
  "6. **External contracts named.**",
];

describe("both agents state the six checks inline", () => {
  for (const [name, text] of PASSES) {
    for (const title of CHECK_TITLES) {
      it(`${name} carries ${title}`, () => {
        expect(occurrences(text, title)).toBe(1);
      });
    }
  }

  it("the enricher points at the decomposer's Step 7 and vice versa", () => {
    expect(occurrences(ENRICHER, "Step 7 of `agents/task-decomposer.md` runs this pass")).toBe(1);
    expect(occurrences(DECOMPOSER, "Phase 4 of `agents/task-enricher.md` holds the same six checks")).toBe(1);
  });

  it("the enricher's 18-item checklist heading is still in place", () => {
    expect(occurrences(ENRICHER_FILE, "**Pre-submission checklist (18 items):**")).toBe(1);
  });
});

describe("check 3 stays pattern matching only", () => {
  for (const [name, text] of PASSES) {
    it(`${name} never runs a prescribed command`, () => {
      expect(occurrences(text, "this agent has no shell, so the prescribed command is never run")).toBe(1);
    });
  }
});

describe("the edge cases", () => {
  it("a task or child with no verification steps still gets the other checks", () => {
    expect(occurrences(ENRICHER, "When a task carries no verification steps, check 1 has nothing to read")).toBe(1);
    expect(occurrences(DECOMPOSER, "When a child carries no verification steps, check 1 has nothing to read")).toBe(1);
  });

  it("a task or child that prescribes no regex or command skips check 3", () => {
    expect(occurrences(ENRICHER, "A task that prescribes nothing skips the check")).toBe(1);
    expect(occurrences(DECOMPOSER, "A child that prescribes nothing skips the check")).toBe(1);
  });

  for (const [name, text] of PASSES) {
    it(`${name}: a pattern with no listed edge case becomes an open question`, () => {
      expect(occurrences(text, "a prescribed pattern with no edge case to read it against earns an open question")).toBe(1);
    });
  }
});

describe("an unevaluable check never blocks, and lands in the right place", () => {
  it("the enricher records it in technical_details.open_questions", () => {
    expect(occurrences(ENRICHER, "each open question goes into `technical_details.open_questions`")).toBe(1);
  });

  it("the enricher's Phase-2-only rule names open_questions as its exception", () => {
    expect(occurrences(ENRICHER_FILE, "The single exception is the `open_questions` key")).toBe(1);
  });

  it("the decomposer adds an Open question sentence to the child's description", () => {
    expect(occurrences(DECOMPOSER, "add one sentence beginning `Open question:` to that child's `description`")).toBe(1);
  });
});

describe("the three skills point at the pass", () => {
  const POINTERS: Array<[string, string, string]> = [
    ["stride-creating-tasks", TASKS_SKILL, "as Phase 4 of `agents/task-enricher.md` lays it out"],
    ["stride-creating-goals", GOALS_SKILL, "as Step 7 of `agents/task-decomposer.md` lays them out"],
    ["stride-enriching-tasks", ENRICHING_SKILL, "as Phase 4 of `agents/task-enricher.md` lays it out"],
  ];

  for (const [name, text, target] of POINTERS) {
    it(`${name} carries exactly one pointer`, () => {
      expect(occurrences(text, "**Cross-field consistency pass.**")).toBe(1);
    });

    it(`${name} names where the pass is stated`, () => {
      expect(occurrences(text, target)).toBe(1);
    });
  }
});
