import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// --- W2305: slim discovery, and enrichment after the claim ---
//
// Discovery asks `GET /api/tasks/next?response_view=slim`, which answers with a
// short summary rather than the task body. The body arrives with the claim, so
// the review of the task and the enrichment check move after it on the plugin
// path. The manual path runs before_doing ahead of the claim, so it fetches the
// body with `GET /api/tasks/:id` first. These tests pin each of those decisions
// in the shipped text, and pin that no instruction quietly goes back to the
// full `next` reply.

const ROOT = join(import.meta.dir, "..");

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

function section(rel: string, start: string, end: string): string {
  const text = read(rel);
  const from = text.indexOf(start);
  if (from < 0) throw new Error(`"${start}" not found in ${rel}`);
  const to = text.indexOf(end, from + start.length);
  if (to < 0) throw new Error(`"${end}" not found after "${start}" in ${rel}`);
  return text.slice(from, to);
}

function shippedDocs(): string[] {
  const files = ["README.md", "AGENTS.md"];
  for (const dir of readdirSync(join(ROOT, "skills"))) {
    for (const f of readdirSync(join(ROOT, "skills", dir))) {
      if (f.endsWith(".md")) files.push(join("skills", dir, f));
    }
  }
  for (const top of ["agents", "commands"]) {
    for (const f of readdirSync(join(ROOT, top))) {
      if (f.endsWith(".md")) files.push(join(top, f));
    }
  }
  return files;
}

// Lines that name the endpoint without telling anyone to call it the old way:
// routing tables, the activation trigger, the creation stop rule and the
// advisory's description of what paces the loop.
const MENTIONS: Array<{ file: string; fragment: string; why: string }> = [
  {
    file: join("skills", "stride-claiming-tasks", "SKILL.md"),
    fragment: "If you are about to call `GET /api/tasks/next` or `POST /api/tasks/claim`",
    why: "activation trigger, names the endpoint only",
  },
  {
    file: join("skills", "stride-claiming-tasks", "SKILL.md"),
    fragment: "- `GET /api/tasks/next` — finding available tasks",
    why: "endpoint inventory",
  },
  {
    file: join("skills", "stride-completing-tasks", "SKILL.md"),
    fragment: "- `GET /api/tasks/next` — finding next task",
    why: "endpoint inventory",
  },
  {
    file: join("skills", "stride-workflow", "SKILL.md"),
    fragment: "do not call `GET /api/tasks/next`, do not claim",
    why: "creation terminal state forbids the call",
  },
  {
    file: join("skills", "stride-workflow", "SKILL.md"),
    fragment: "(or `GET /api/tasks/next`) reports a task is not available",
    why: "claim-fail guard, about the outcome not the request",
  },
  {
    file: "AGENTS.md",
    fragment: "| `GET /api/tasks/next` or `POST /api/tasks/claim` | `stride-claiming-tasks` |",
    why: "routing table",
  },
  {
    file: "README.md",
    fragment: "BEFORE calling GET /api/tasks/next or POST /api/tasks/claim",
    why: "routing diagram",
  },
  {
    file: "README.md",
    fragment: "| `stride-claiming-tasks` | `GET /api/tasks/next` or `POST /api/tasks/claim` |",
    why: "routing table",
  },
  {
    file: "README.md",
    fragment: "the pacing is set by whatever `GET /api/tasks/next` keeps returning",
    why: "describes what the advisory loop follows",
  },
];

describe("every next call in the shipped text is slim", () => {
  it("names the slim view on every line, or is a listed mention", () => {
    const offenders: string[] = [];
    for (const file of shippedDocs()) {
      read(file)
        .split("\n")
        .forEach((line, i) => {
          if (!line.includes("/api/tasks/next")) return;
          if (line.includes("/api/tasks/next?response_view=slim")) return;
          if (MENTIONS.some((m) => m.file === file && line.includes(m.fragment))) return;
          offenders.push(`${file}:${i + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  it("keeps each listed mention pointing at exactly one line", () => {
    for (const m of MENTIONS) {
      const hits = read(m.file)
        .split("\n")
        .filter((line) => line.includes(m.fragment));
      expect({ fragment: m.fragment, hits: hits.length }).toEqual({
        fragment: m.fragment,
        hits: 1,
      });
    }
  });

  it("asks the slim view from the plugin's own advisory request", () => {
    expect(read(join("src", "advisory-continuation.ts"))).toContain(
      "/api/tasks/next?response_view=slim`",
    );
  });
});

const WORKFLOW = join("skills", "stride-workflow", "SKILL.md");
const CLAIMING = join("skills", "stride-claiming-tasks", "SKILL.md");

describe("stride-workflow reviews and enriches from the claim reply", () => {
  const step1 = section(WORKFLOW, "## Step 1: Task Discovery", "## Step 2");
  const step2 = section(WORKFLOW, "## Step 2: Claim the Task", "## Step 3");

  it("Step 1 discovers with the slim view and enriches nothing", () => {
    expect(step1).toContain("GET /api/tasks/next?response_view=slim");
    expect(step1).not.toMatch(/Enrichment check/);
    expect(step1).not.toContain("acceptance_criteria` -- your definition of done");
  });

  it("Step 2 reads the full task from the claim and runs the enrichment check there", () => {
    expect(step2).toContain("claim reply");
    expect(step2).toContain("acceptance_criteria` -- your definition of done");
    expect(step2).toMatch(/Enrichment check/);
    expect(step2).toContain("before proceeding to Step 3");
    expect(step2).not.toContain("before proceeding to Step 2");
    expect(step2.indexOf("POST /api/tasks/claim")).toBeLessThan(
      step2.indexOf("Enrichment check"),
    );
  });

  it("sends an enriched task inline, because its saved file predates the PATCH", () => {
    expect(step2).toMatch(/enriched task travels inline/);
    const branchC = section(WORKFLOW, "### Branch C", "## Step 4");
    expect(branchC).toContain("A task enriched in Step 2 takes this inline path");
  });

  it("the flowchart enriches after the claim", () => {
    const flow = section(WORKFLOW, "## Complete Workflow Flowchart", "## Failure Modes");
    const s1 = flow.indexOf("STEP 1:");
    const s2 = flow.indexOf("STEP 2:");
    const s3 = flow.indexOf("STEP 3:");
    expect(flow.slice(s1, s2)).toContain("response_view=slim");
    expect(flow.slice(s1, s2)).not.toMatch(/enrich/i);
    expect(flow.slice(s2, s3)).toMatch(/enrich/i);
  });

  it("the quick reference enriches after the claim", () => {
    const card = section(WORKFLOW, "## Quick Reference Card", "├─ 3.");
    const discovery = card.slice(card.indexOf("├─ 1."), card.indexOf("├─ 2."));
    expect(discovery).toContain("response_view=slim");
    expect(discovery).not.toMatch(/enrich/i);
    expect(card.slice(card.indexOf("├─ 2."))).toMatch(/enrich/i);
  });
});

describe("stride-claiming-tasks orders discovery by path", () => {
  it("with the plugin, the claim comes before the review and the completeness check", () => {
    const listing = section(CLAIMING, "### With Plugin Installed", "### Without Plugin");
    const slim = listing.indexOf("GET /api/tasks/next?response_view=slim");
    const claim = listing.indexOf("POST /api/tasks/claim");
    const review = listing.indexOf("Review task details");
    const check = listing.indexOf("Check task completeness");
    expect(slim).toBeGreaterThan(-1);
    expect(slim).toBeLessThan(claim);
    expect(claim).toBeLessThan(review);
    expect(review).toBeLessThan(check);
    expect(listing).not.toContain("GET /api/tasks/<identifier>");
    expect(listing).not.toContain("GET /api/tasks/:id");
  });

  it("without the plugin, the body is fetched by id before the hook and the claim", () => {
    for (const [start, end] of [
      ["### Without Plugin (Manual Hooks)", "## Claiming Workflow Flowchart"],
      ["## Implementation Workflow", "## Quick Reference Card"],
    ] as const) {
      const listing = section(CLAIMING, start, end);
      const slim = listing.indexOf("GET /api/tasks/next?response_view=slim");
      const show = listing.search(/GET \/api\/tasks\/(:id|<identifier>)/);
      const hook = listing.search(/before_doing hook|before_doing section/);
      expect(slim).toBeGreaterThan(-1);
      expect(slim).toBeLessThan(show);
      expect(show).toBeLessThan(hook);
    }
  });

  it("no shipped text still puts enrichment before claiming", () => {
    for (const file of shippedDocs()) {
      expect({ file, hit: /enrich[^\n]*before claiming/i.test(read(file)) }).toEqual({
        file,
        hit: false,
      });
    }
  });
});
