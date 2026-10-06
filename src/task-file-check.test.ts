import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- W2301: the TASK_FILE identity check in stride-workflow Step 3 Branch C ---
//
// The skill tells the orchestrator to run a shell snippet that prints one word
// before it passes `.stride/.task-<IDENTIFIER>.json` to an agent. These tests
// lift that snippet out of the skill text, so they pin the instructions an
// agent actually follows rather than a copy that could drift from them.

const SKILL = join(import.meta.dir, "..", "skills", "stride-workflow", "SKILL.md");
const PLACEHOLDER = "<identifier from the claim reply>";

function extractCheck(): string {
  const text = readFileSync(SKILL, "utf8");
  const at = text.indexOf(`ID='${PLACEHOLDER}'`);
  if (at < 0) throw new Error("identity-check snippet not found in stride-workflow SKILL.md");
  const open = text.lastIndexOf("```bash\n", at);
  const close = text.indexOf("\n   ```", at);
  if (open < 0 || close < 0) throw new Error("identity-check snippet is not inside a bash fence");
  return text
    .slice(open + "```bash\n".length, close)
    .split("\n")
    .map((line) => line.replace(/^ {3}/, ""))
    .join("\n");
}

const CHECK = extractCheck();

let root: string;
let noJqPath: string;

function runCheck(id: string, projectDir: string, path = process.env.PATH ?? ""): string {
  const script = CHECK.replace(PLACEHOLDER, id);
  const result = Bun.spawnSync(["bash", "-c", script], {
    env: { PATH: path, OPENCODE_PROJECT_DIR: projectDir },
  });
  return result.stdout.toString().trim();
}

function writeTaskFile(dir: string, stem: string, body: string): void {
  mkdirSync(join(dir, ".stride"), { recursive: true });
  writeFileSync(join(dir, ".stride", `.task-${stem}.json`), body);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "stride-taskfile-check-"));
  writeTaskFile(root, "W2301", JSON.stringify({ id: 7267, identifier: "W2301", title: "x" }) + "\n");
  // A file saved under one name whose content is another task.
  writeTaskFile(root, "W2300", JSON.stringify({ id: 7266, identifier: "W9999", title: "x" }) + "\n");
  writeTaskFile(root, "W1", '{"identifier":"W1"');
  writeTaskFile(
    root,
    "W2",
    JSON.stringify({ identifier: "W2" }) + JSON.stringify({ identifier: "W3" }) + "\n",
  );

  // A PATH with bash, grep and wc but no jq, to exercise the grep branch.
  noJqPath = join(root, "nojq-bin");
  mkdirSync(noJqPath);
  for (const tool of ["bash", "grep", "wc"]) {
    const found = Bun.which(tool);
    if (found) symlinkSync(found, join(noJqPath, tool));
  }
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("TASK_FILE identity check (stride-workflow Step 3 Branch C)", () => {
  it("is present in the skill and carries the placeholder exactly once", () => {
    expect(CHECK.split(PLACEHOLDER).length).toBe(2);
  });

  it("prints match for this task's own file", () => {
    expect(runCheck("W2301", root)).toBe("match");
  });

  it("prints absent when no file was saved", () => {
    expect(runCheck("W4242", root)).toBe("absent");
  });

  it("prints mismatch when the file names another task", () => {
    expect(runCheck("W2300", root)).toBe("mismatch");
  });

  it("prints unreadable for a file cut short", () => {
    expect(runCheck("W1", root)).toBe("unreadable");
  });

  it("prints exactly one word when the file holds more than one JSON value", () => {
    const out = runCheck("W2", root);
    expect(out.split("\n").length).toBe(1);
    expect(out).not.toBe("match");
  });

  it("prints invalid-id for an empty, path-like or over-long identifier", () => {
    expect(runCheck("", root)).toBe("invalid-id");
    expect(runCheck("bad/id", root)).toBe("invalid-id");
    expect(runCheck("../W2301", root)).toBe("invalid-id");
    expect(runCheck("A".repeat(65), root)).toBe("invalid-id");
  });

  describe("without jq on PATH", () => {
    it("prints match for this task's own file", () => {
      expect(runCheck("W2301", root, noJqPath)).toBe("match");
    });

    it("prints mismatch when the file names another task", () => {
      expect(runCheck("W2300", root, noJqPath)).toBe("mismatch");
    });

    it("prints absent when no file was saved", () => {
      expect(runCheck("W4242", root, noJqPath)).toBe("absent");
    });
  });
});
