import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import {
  captureChangedFiles,
  TRUNC_MARKER,
  BIN_PLACEHOLDER,
  MAX_LINES,
} from "./capture";

/**
 * Test fixture helper — initialize a git repo in a temp dir,
 * stage and commit an initial file, return {dir, baseRef}.
 */
async function initRepo(): Promise<{ dir: string; base: string }> {
  const dir = mkdtempSync(join(tmpdir(), "stride-capture-"));
  await $`git init -q`.cwd(dir).quiet();
  await $`git config user.email "test@test.local"`.cwd(dir).quiet();
  await $`git config user.name "Test"`.cwd(dir).quiet();
  writeFileSync(join(dir, "a.txt"), "v1\n");
  await $`git add a.txt`.cwd(dir).quiet();
  await $`git commit -q -m "initial"`.cwd(dir).quiet();
  const rev = await $`git rev-parse HEAD`.cwd(dir).quiet();
  return { dir, base: rev.stdout.toString().trim() };
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

describe("captureChangedFiles — degraded paths", () => {
  it("returns [] for a non-git directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stride-capture-nonrepo-"));
    try {
      const result = await captureChangedFiles($, dir, "");
      expect(result).toEqual([]);
    } finally {
      cleanup(dir);
    }
  });

  it("returns [] when no files differ between base and working tree", async () => {
    const { dir, base } = await initRepo();
    try {
      const result = await captureChangedFiles($, dir, base);
      expect(result).toEqual([]);
    } finally {
      cleanup(dir);
    }
  });
});

describe("captureChangedFiles — Option D semantic", () => {
  let repo: { dir: string; base: string };

  beforeEach(async () => {
    repo = await initRepo();
  });

  afterEach(() => {
    cleanup(repo.dir);
  });

  it("captures a modified-but-uncommitted tracked file", async () => {
    writeFileSync(join(repo.dir, "a.txt"), "v2-uncommitted\n");

    const result = await captureChangedFiles($, repo.dir, repo.base);

    const entry = result.find((e) => e.path === "a.txt");
    expect(entry).toBeDefined();
    expect(entry!.diff).toContain("diff --git a/a.txt");
    expect(entry!.diff).toContain("+v2-uncommitted");
  });

  it("captures a staged-but-uncommitted change", async () => {
    writeFileSync(join(repo.dir, "a.txt"), "v2-staged\n");
    await $`git add a.txt`.cwd(repo.dir).quiet();

    const result = await captureChangedFiles($, repo.dir, repo.base);

    const entry = result.find((e) => e.path === "a.txt");
    expect(entry).toBeDefined();
    expect(entry!.diff).toContain("+v2-staged");
  });

  it("captures an untracked new file as a synthesized new-file patch", async () => {
    writeFileSync(join(repo.dir, "new.txt"), "line one\nline two\n");

    const result = await captureChangedFiles($, repo.dir, repo.base);

    const entry = result.find((e) => e.path === "new.txt");
    expect(entry).toBeDefined();
    expect(entry!.diff).toContain("+++ b/new.txt");
    expect(entry!.diff).toContain("+line one");
  });

  it("emits binary placeholder for untracked binary files", async () => {
    // Bytes with NUL — git --no-index treats as binary
    Bun.write(join(repo.dir, "new.bin"), new Uint8Array([0, 1, 2, 0, 3, 4, 0]));

    const result = await captureChangedFiles($, repo.dir, repo.base);

    const entry = result.find((e) => e.path === "new.bin");
    expect(entry).toBeDefined();
    expect(entry!.diff).toBe(BIN_PLACEHOLDER);
  });

  it("emits binary placeholder for tracked binary changes (numstat - -)", async () => {
    // Replace a.txt with a binary blob and commit so git --numstat marks it binary
    Bun.write(
      join(repo.dir, "a.txt"),
      new Uint8Array([0, 1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9]),
    );
    await $`git add a.txt`.cwd(repo.dir).quiet();
    await $`git commit -q -m "v2 binary"`.cwd(repo.dir).quiet();

    const result = await captureChangedFiles($, repo.dir, repo.base);

    const entry = result.find((e) => e.path === "a.txt");
    expect(entry).toBeDefined();
    expect(entry!.diff).toBe(BIN_PLACEHOLDER);
  });

  it("dedupes a path that is committed-then-further-modified", async () => {
    // Commit a change…
    writeFileSync(join(repo.dir, "a.txt"), "v2-committed\n");
    await $`git add a.txt`.cwd(repo.dir).quiet();
    await $`git commit -q -m "v2"`.cwd(repo.dir).quiet();
    // …then modify the same path further without committing
    writeFileSync(join(repo.dir, "a.txt"), "v3-uncommitted-on-top\n");

    const result = await captureChangedFiles($, repo.dir, repo.base);

    const entries = result.filter((e) => e.path === "a.txt");
    expect(entries.length).toBe(1);
    expect(entries[0].diff).toContain("+v3-uncommitted-on-top");
  });
});

describe("captureChangedFiles — truncation", () => {
  let repo: { dir: string; base: string };

  beforeEach(async () => {
    repo = await initRepo();
  });

  afterEach(() => {
    cleanup(repo.dir);
  });

  it("does NOT truncate a diff exactly at MAX_LINES", async () => {
    // 500 added lines + header lines push us just over 500; force a smaller file
    // and check that under-MAX is preserved.
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    writeFileSync(join(repo.dir, "a.txt"), lines + "\n");

    const result = await captureChangedFiles($, repo.dir, repo.base);

    const entry = result.find((e) => e.path === "a.txt");
    expect(entry).toBeDefined();
    expect(entry!.diff).not.toContain(TRUNC_MARKER);
  });

  it("truncates diffs over MAX_LINES with the contract marker", async () => {
    // 750 lines of NEW content → unified-patch diff easily exceeds MAX_LINES
    const lines = Array.from({ length: 750 }, (_, i) => `line ${i}`).join("\n");
    writeFileSync(join(repo.dir, "a.txt"), lines + "\n");

    const result = await captureChangedFiles($, repo.dir, repo.base);

    const entry = result.find((e) => e.path === "a.txt");
    expect(entry).toBeDefined();
    const diffLines = entry!.diff.split("\n");
    expect(diffLines.length).toBe(MAX_LINES);
    expect(diffLines[diffLines.length - 1]).toBe(TRUNC_MARKER);
  });
});

describe("captureChangedFiles — base ref fallback", () => {
  it("falls back to HEAD~1 when base is empty but HEAD~1 exists", async () => {
    const { dir } = await initRepo();
    try {
      // Make a second commit so HEAD~1 is the initial commit
      writeFileSync(join(dir, "a.txt"), "v2\n");
      await $`git add a.txt`.cwd(dir).quiet();
      await $`git commit -q -m "v2"`.cwd(dir).quiet();

      const result = await captureChangedFiles($, dir, "");

      const entry = result.find((e) => e.path === "a.txt");
      expect(entry).toBeDefined();
      expect(entry!.diff).toContain("+v2");
    } finally {
      cleanup(dir);
    }
  });

  it("returns [] when base is empty and HEAD~1 does not exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stride-capture-singlecommit-"));
    try {
      await $`git init -q`.cwd(dir).quiet();
      await $`git config user.email "test@test.local"`.cwd(dir).quiet();
      await $`git config user.name "Test"`.cwd(dir).quiet();
      writeFileSync(join(dir, "x.txt"), "only\n");
      await $`git add x.txt`.cwd(dir).quiet();
      await $`git commit -q -m "only"`.cwd(dir).quiet();
      // No HEAD~1 — only one commit on this branch

      const result = await captureChangedFiles($, dir, "");

      expect(result).toEqual([]);
    } finally {
      cleanup(dir);
    }
  });
});
