import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import {
  captureChangedFiles,
  resolveSnapshotBase,
  extractApiBase,
  extractToken,
  resolveStrideApiUrl,
  resolveStrideApiToken,
  putChangedFiles,
  recordDiffUploadState,
  readDiffUploadState,
  markDiffUploadUnresolved,
  writeEnvCache,
  readEnvCache,
  clearEnvCache,
  getAfterGoalStatus,
  writeCanonicalResponse,
  readCanonicalResponse,
  CANONICAL_RESPONSE_FILE,
  LOOP_STATE_FILE,
  writeLoopState,
  clearLoopState,
  loopStateSafe,
  completedAtNow,
  PUT_TIMEOUT_MS,
  TRUNC_MARKER,
  BIN_PLACEHOLDER,
  MAX_LINES,
  type ChangedFile,
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

describe("captureChangedFiles — D67 root-artifact exclusion", () => {
  it("excludes an untracked .stride-diff-upload-state / .stride-changed-files.json / .stride-env-cache while keeping a real change", async () => {
    const { dir, base } = await initRepo();
    try {
      writeFileSync(join(dir, "a.txt"), "changed\n");
      writeFileSync(join(dir, ".stride-diff-upload-state"), "task_id=42\nhttp_code=200\n");
      writeFileSync(join(dir, ".stride-changed-files.json"), "[]\n");
      writeFileSync(join(dir, ".stride-env-cache"), '{"TASK_ID":"42"}\n');
      const result = await captureChangedFiles($, dir, base);
      const paths = result.map((f) => f.path);
      expect(paths).toContain("a.txt");
      expect(paths).not.toContain(".stride-diff-upload-state");
      expect(paths).not.toContain(".stride-changed-files.json");
      expect(paths).not.toContain(".stride-env-cache");
    } finally {
      cleanup(dir);
    }
  });

  it("excludes a COMMITTED-and-modified state file (the auto-commit case)", async () => {
    const { dir } = await initRepo();
    try {
      writeFileSync(join(dir, ".stride-diff-upload-state"), "task_id=1\nhttp_code=200\n");
      await $`git add -A`.cwd(dir).quiet();
      await $`git commit -q -m "state committed"`.cwd(dir).quiet();
      const base = (await $`git rev-parse HEAD`.cwd(dir).quiet()).stdout.toString().trim();
      writeFileSync(join(dir, ".stride-diff-upload-state"), "task_id=2\nhttp_code=200\n");
      writeFileSync(join(dir, "a.txt"), "v2\n");
      await $`git add -A`.cwd(dir).quiet();
      await $`git commit -q -m "v2"`.cwd(dir).quiet();
      const result = await captureChangedFiles($, dir, base);
      const paths = result.map((f) => f.path);
      expect(paths).toContain("a.txt");
      expect(paths).not.toContain(".stride-diff-upload-state");
    } finally {
      cleanup(dir);
    }
  });

  it("anchors to the repo root — a same-named file in a subdirectory is still captured", async () => {
    const { dir, base } = await initRepo();
    try {
      mkdirSync(join(dir, "sub"));
      writeFileSync(join(dir, "sub", ".stride-diff-upload-state"), "user data\n");
      writeFileSync(join(dir, "sub", ".stride-changed-files.json"), "user snapshot\n");
      writeFileSync(join(dir, "sub", ".stride-env-cache"), "user cache\n");
      const result = await captureChangedFiles($, dir, base);
      const paths = result.map((f) => f.path);
      expect(paths).toContain("sub/.stride-diff-upload-state");
      expect(paths).toContain("sub/.stride-changed-files.json");
      expect(paths).toContain("sub/.stride-env-cache");
    } finally {
      cleanup(dir);
    }
  });

  it("yields [] when the hook's own artifacts are the only changed paths", async () => {
    const { dir, base } = await initRepo();
    try {
      writeFileSync(join(dir, ".stride-diff-upload-state"), "task_id=9\nhttp_code=200\n");
      writeFileSync(join(dir, ".stride-changed-files.json"), "[]\n");
      const result = await captureChangedFiles($, dir, base);
      expect(result).toEqual([]);
    } finally {
      cleanup(dir);
    }
  });
});

describe("extractApiBase / extractToken", () => {
  it("pulls https URL out of a /complete curl", () => {
    const cmd = 'curl -X PATCH https://stride.example.com/api/tasks/42/complete -H "Authorization: Bearer test_token_abc123"';
    expect(extractApiBase(cmd)).toBe("https://stride.example.com");
  });

  it("pulls http URL with port out of a curl", () => {
    const cmd = "curl -X PATCH http://localhost:4000/api/tasks/42/complete -H 'Authorization: Bearer tok'";
    expect(extractApiBase(cmd)).toBe("http://localhost:4000");
  });

  it("returns null on empty command", () => {
    expect(extractApiBase("")).toBeNull();
    expect(extractToken("")).toBeNull();
  });

  it("returns null when no URL is present", () => {
    expect(extractApiBase("git status")).toBeNull();
  });

  it("pulls Bearer token out of an Authorization header", () => {
    const cmd = 'curl -X PATCH https://stride.example.com/api/tasks/42/complete -H "Authorization: Bearer test_token_abc123"';
    expect(extractToken(cmd)).toBe("test_token_abc123");
  });

  it("returns null when no Bearer token is present", () => {
    expect(extractToken("curl https://stride.example.com/api/tasks/42/complete")).toBeNull();
  });

  it("handles tokens with allowed special characters", () => {
    const cmd = 'curl -H "Authorization: Bearer stride_dev_abc.+/=-XYZ"';
    expect(extractToken(cmd)).toBe("stride_dev_abc.+/=-XYZ");
  });
});

describe("putChangedFiles", () => {
  const originalFetch = globalThis.fetch;
  let captured: { url: string; init: RequestInit } | null = null;

  beforeEach(() => {
    captured = null;
    // Stub fetch with a minimal Response-like object so the helper doesn't
    // hit the network. Casting to fetch's type to satisfy TS — this stub
    // only needs to round-trip through the helper's try/catch.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response("", { status: 200 });
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("PUTs the base64-encoded changed_files envelope (D61)", async () => {
    const files: ChangedFile[] = [{ path: "foo.txt", diff: "unified patch body" }];
    await putChangedFiles("https://stride.example.com", "test_token_abc123", "42", files);

    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("https://stride.example.com/api/tasks/42/changed_files");
    expect(captured!.init.method).toBe("PUT");
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test_token_abc123");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = captured!.init.body as string;
    // D61: transport-encoded envelope, NOT a bare array and NOT raw diff text.
    const parsed = JSON.parse(body);
    expect(parsed.changed_files.encoding).toBe("base64");
    expect(typeof parsed.changed_files.data).toBe("string");
    expect(Array.isArray(parsed)).toBe(false);
    // Raw diff/path text must be absent from the wire body (it is base64).
    expect(body).not.toContain("foo.txt");
    // Round-trip: the data field is base64 of the snapshot array JSON and
    // decodes back to the original files list.
    const expectedData = Buffer.from(JSON.stringify(files), "utf8").toString("base64");
    expect(parsed.changed_files.data).toBe(expectedData);
    expect(
      JSON.parse(Buffer.from(parsed.changed_files.data, "base64").toString("utf8")),
    ).toEqual(files);
  });

  it("wraps empty snapshot as the base64-encoded envelope (D61) — not a bare array", async () => {
    await putChangedFiles("https://stride.example.com", "tok", "42", []);
    expect(captured).not.toBeNull();
    const body = captured!.init.body as string;
    const parsed = JSON.parse(body);
    expect(parsed.changed_files.encoding).toBe("base64");
    expect(Array.isArray(parsed)).toBe(false);
    const expectedData = Buffer.from(JSON.stringify([]), "utf8").toString("base64");
    expect(parsed.changed_files.data).toBe(expectedData);
    expect(
      JSON.parse(Buffer.from(parsed.changed_files.data, "base64").toString("utf8")),
    ).toEqual([]);
  });

  it("warns to stderr on a non-2xx response without throwing (D61)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response("nope", { status: 500 });
    };
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.join(" "));
    };
    try {
      await putChangedFiles("https://stride.example.com", "tok", "42", []);
    } finally {
      console.error = originalError;
    }
    expect(
      errors.some((e) => e.includes("changed_files upload failed (HTTP 500) for task 42")),
    ).toBe(true);
    // The token must never appear in the warning.
    expect(errors.join(" ")).not.toContain("tok");
  });

  it("strips trailing slash from apiBase", async () => {
    await putChangedFiles("https://stride.example.com/", "tok", "42", []);
    expect(captured!.url).toBe("https://stride.example.com/api/tasks/42/changed_files");
  });

  it("no-ops silently when apiBase is null", async () => {
    await putChangedFiles(null, "tok", "42", []);
    expect(captured).toBeNull();
  });

  it("no-ops silently when token is null", async () => {
    await putChangedFiles("https://stride.example.com", null, "42", []);
    expect(captured).toBeNull();
  });

  it("no-ops silently when taskId is null/undefined", async () => {
    await putChangedFiles("https://stride.example.com", "tok", null, []);
    expect(captured).toBeNull();
    await putChangedFiles("https://stride.example.com", "tok", undefined, []);
    expect(captured).toBeNull();
  });

  it("swallows fetch errors (fire-and-forget) — does not throw", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    // No throw — helper swallows the error.
    await putChangedFiles("https://stride.example.com", "tok", "42", [
      { path: "a.txt", diff: "" },
    ]);
  });

  it("returns the HTTP status code on a 2xx (W1094)", async () => {
    const code = await putChangedFiles("https://stride.example.com", "tok", "42", []);
    expect(code).toBe(200);
  });

  it("returns the HTTP status code on a non-2xx (W1094)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async () => new Response("nope", { status: 503 });
    const originalError = console.error;
    console.error = () => {};
    try {
      const code = await putChangedFiles("https://stride.example.com", "tok", "42", []);
      expect(code).toBe(503);
    } finally {
      console.error = originalError;
    }
  });

  it("returns 0 on a transport failure, mirroring the bash '000' (W1094)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const originalError = console.error;
    console.error = () => {};
    try {
      const code = await putChangedFiles("https://stride.example.com", "tok", "42", []);
      expect(code).toBe(0);
    } finally {
      console.error = originalError;
    }
  });

  it("returns null (no PUT attempted) on a prerequisite miss (W1094)", async () => {
    expect(await putChangedFiles(null, "tok", "42", [])).toBeNull();
    expect(await putChangedFiles("https://stride.example.com", null, "42", [])).toBeNull();
    expect(await putChangedFiles("https://stride.example.com", "tok", null, [])).toBeNull();
  });

  it("passes an abort timeout of roughly 10 seconds to the fetch (W1498)", async () => {
    let seenSignal: unknown;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async (_url: string, init?: { signal?: unknown }) => {
      seenSignal = init?.signal;
      return new Response("", { status: 200 });
    };
    await putChangedFiles("https://stride.example.com", "tok", "42", []);
    expect(seenSignal instanceof AbortSignal).toBe(true);
    expect(PUT_TIMEOUT_MS).toBe(10_000);
  });

  it("maps a timed-out (aborted) fetch to the transport-failure path: 0, warning without the token (W1498)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    };
    const originalError = console.error;
    let warned = "";
    console.error = (msg: unknown) => {
      warned += String(msg);
    };
    try {
      const code = await putChangedFiles("https://stride.example.com", "tok", "42", []);
      expect(code).toBe(0);
      expect(warned).toContain("changed_files upload failed for task 42");
      expect(warned).not.toContain("tok");
    } finally {
      console.error = originalError;
    }
  });

  it("a timed-out attempt is recorded as http_code=0 so the self-heal retries (W1498)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stride-put-timeout-"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    };
    const originalError = console.error;
    console.error = () => {};
    try {
      const code = await putChangedFiles("https://stride.example.com", "tok", "42", []);
      expect(code).toBe(0);
      await recordDiffUploadState(dir, "42", code as number);
      const state = await readDiffUploadState(dir);
      expect(state).toEqual({ taskId: "42", httpCode: "0" });
      // The W1094 healthy short-circuit requires a 2xx — "0" must not match.
      expect(/^2/.test((state as { httpCode: string }).httpCode)).toBe(false);
    } finally {
      console.error = originalError;
      cleanup(dir);
    }
  });
});

describe("recordDiffUploadState / readDiffUploadState (W1094)", () => {
  it("records ONLY task id + HTTP code — never a URL or token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stride-state-"));
    try {
      await recordDiffUploadState(dir, "42", 200);
      const text = require("node:fs").readFileSync(
        join(dir, ".stride-diff-upload-state"),
        "utf8",
      );
      expect(text).toBe("task_id=42\nhttp_code=200\n");
      expect(text).not.toMatch(/Bearer|https?:\/\//);
    } finally {
      cleanup(dir);
    }
  });

  it("round-trips through readDiffUploadState", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stride-state-"));
    try {
      await recordDiffUploadState(dir, "99", 503);
      const state = await readDiffUploadState(dir);
      expect(state).toEqual({ taskId: "99", httpCode: "503" });
    } finally {
      cleanup(dir);
    }
  });

  it("returns null when the state file is absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stride-state-"));
    try {
      expect(await readDiffUploadState(dir)).toBeNull();
    } finally {
      cleanup(dir);
    }
  });
});

describe("markDiffUploadUnresolved (W1658)", () => {
  it("appends unresolved=yes to the recorded state without a URL or token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stride-state-"));
    try {
      await recordDiffUploadState(dir, "42", 500);
      await markDiffUploadUnresolved(dir);
      const text = require("node:fs").readFileSync(
        join(dir, ".stride-diff-upload-state"),
        "utf8",
      );
      expect(text).toBe("task_id=42\nhttp_code=500\nunresolved=yes\n");
      expect(text).not.toMatch(/Bearer|https?:\/\//);
    } finally {
      cleanup(dir);
    }
  });

  it("is self-clearing: a subsequent record overwrites the marker away", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stride-state-"));
    try {
      await recordDiffUploadState(dir, "42", 500);
      await markDiffUploadUnresolved(dir);
      // A later successful PUT records anew — the overwrite drops the marker.
      await recordDiffUploadState(dir, "42", 200);
      const text = require("node:fs").readFileSync(
        join(dir, ".stride-diff-upload-state"),
        "utf8",
      );
      expect(text).toBe("task_id=42\nhttp_code=200\n");
      expect(text).not.toContain("unresolved");
    } finally {
      cleanup(dir);
    }
  });

  it("writes the marker even when no state file exists yet (best-effort)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stride-state-"));
    try {
      await markDiffUploadUnresolved(dir);
      const text = require("node:fs").readFileSync(
        join(dir, ".stride-diff-upload-state"),
        "utf8",
      );
      expect(text).toBe("unresolved=yes\n");
    } finally {
      cleanup(dir);
    }
  });
});

describe("writeEnvCache / readEnvCache / clearEnvCache (W1496)", () => {
  it("round-trips a cache with special characters in values — and never a token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stride-envcache-"));
    try {
      const env = {
        TASK_ID: "42",
        TASK_TITLE: "Pay $100 via `whoami` \"double\" 'single'",
        TASK_BASE_REF: "abc123",
      };
      await writeEnvCache(dir, env);
      expect(await readEnvCache(dir)).toEqual(env);
      const text = require("node:fs").readFileSync(
        join(dir, ".stride-env-cache"),
        "utf8",
      );
      expect(text).not.toMatch(/Bearer|stride_dev_/);
    } finally {
      cleanup(dir);
    }
  });

  it("returns {} when the cache file is absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stride-envcache-"));
    try {
      expect(await readEnvCache(dir)).toEqual({});
    } finally {
      cleanup(dir);
    }
  });

  it("degrades malformed JSON to {} without throwing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stride-envcache-"));
    try {
      writeFileSync(join(dir, ".stride-env-cache"), "{not json");
      expect(await readEnvCache(dir)).toEqual({});
    } finally {
      cleanup(dir);
    }
  });

  it("rejects non-object shapes and drops non-string values", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stride-envcache-"));
    try {
      writeFileSync(join(dir, ".stride-env-cache"), '["a"]\n');
      expect(await readEnvCache(dir)).toEqual({});
      writeFileSync(
        join(dir, ".stride-env-cache"),
        '{"TASK_ID": 42, "TASK_TITLE": "ok"}\n',
      );
      expect(await readEnvCache(dir)).toEqual({ TASK_TITLE: "ok" });
    } finally {
      cleanup(dir);
    }
  });

  it("clearEnvCache removes the file and tolerates a missing file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stride-envcache-"));
    try {
      await writeEnvCache(dir, { TASK_ID: "42" });
      expect(existsSync(join(dir, ".stride-env-cache"))).toBe(true);
      await clearEnvCache(dir);
      expect(existsSync(join(dir, ".stride-env-cache"))).toBe(false);
      // Second clear on the already-missing file resolves without throwing.
      await clearEnvCache(dir);
    } finally {
      cleanup(dir);
    }
  });
});

describe("resolveStrideApiUrl / resolveStrideApiToken (D54)", () => {
  const PROD_TOKEN = "stride_dev_PRODtoken123+/=";
  const LOCAL_TOKEN = "stride_dev_LOCALtoken456";
  const AUTH_URL = "https://www.stridelikeaboss.com";

  // Mirrors the real .stride_auth.md shape: a Local line AND a production line,
  // with the Local line listed FIRST to prove order doesn't fool resolution.
  const fullAuth = [
    "# Stride API Authentication",
    "",
    "## API Configuration",
    "",
    `- **API URL:** \`${AUTH_URL}\``,
    `- **Local API Token:** \`${LOCAL_TOKEN}\``,
    `- **API Token:** \`${PROD_TOKEN}\``,
    "- **User Email:** `me@example.com`",
    "",
  ].join("\n");

  function writeAuth(dir: string, body: string): void {
    writeFileSync(join(dir, ".stride_auth.md"), body);
  }

  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "stride-auth-"));
  });
  afterEach(() => cleanup(dir));

  it("resolves URL and token from .stride_auth.md as the PRIMARY source", async () => {
    writeAuth(dir, fullAuth);
    // The command carries DIFFERENT literals — the auth file must win.
    const cmd =
      "curl -X PUT https://other.example.com/api -H 'Authorization: Bearer cmd_token_zzz'";
    expect(await resolveStrideApiUrl(dir, cmd)).toBe(AUTH_URL);
    expect(await resolveStrideApiToken(dir, cmd)).toBe(PROD_TOKEN);
  });

  it("resolves the production **API Token:** line, NOT **Local API Token:**", async () => {
    writeAuth(dir, fullAuth);
    const token = await resolveStrideApiToken(dir, "");
    expect(token).toBe(PROD_TOKEN);
    expect(token).not.toBe(LOCAL_TOKEN);
  });

  it("never returns the Local token when ONLY the Local line is present", async () => {
    writeAuth(dir, `- **Local API Token:** \`${LOCAL_TOKEN}\`\n`);
    // No command fallback either → null, and crucially NOT the Local token.
    const token = await resolveStrideApiToken(dir, "");
    expect(token).toBeNull();
    expect(token).not.toBe(LOCAL_TOKEN);
  });

  it("falls back to command literals when the auth file is absent", async () => {
    const cmd =
      'curl -X PUT https://fallback.example.com/api/tasks/9/complete -H "Authorization: Bearer fallback_tok_abc"';
    expect(await resolveStrideApiUrl(dir, cmd)).toBe("https://fallback.example.com");
    expect(await resolveStrideApiToken(dir, cmd)).toBe("fallback_tok_abc");
  });

  it("falls back to command literals when the auth file lacks the relevant lines", async () => {
    writeAuth(dir, "# Stride API Authentication\n\n- **User Email:** `me@example.com`\n");
    const cmd = "curl https://cmd.example.com -H 'Authorization: Bearer cmd_only_tok'";
    expect(await resolveStrideApiUrl(dir, cmd)).toBe("https://cmd.example.com");
    expect(await resolveStrideApiToken(dir, cmd)).toBe("cmd_only_tok");
  });

  it("returns null when neither the auth file nor the command yields creds", async () => {
    expect(await resolveStrideApiUrl(dir, "")).toBeNull();
    expect(await resolveStrideApiToken(dir, "")).toBeNull();
  });

  it("never logs the resolved token (no console/stderr leak)", async () => {
    writeAuth(dir, fullAuth);
    const sink: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    const origWarn = console.warn;
    const origStderr = process.stderr.write.bind(process.stderr);
    console.log = (...a: unknown[]) => void sink.push(a.join(" "));
    console.error = (...a: unknown[]) => void sink.push(a.join(" "));
    console.warn = (...a: unknown[]) => void sink.push(a.join(" "));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = (chunk: unknown) => {
      sink.push(String(chunk));
      return true;
    };
    try {
      const token = await resolveStrideApiToken(
        dir,
        `curl -H 'Authorization: Bearer ${PROD_TOKEN}'`,
      );
      expect(token).toBe(PROD_TOKEN);
    } finally {
      console.log = origLog;
      console.error = origErr;
      console.warn = origWarn;
      process.stderr.write = origStderr;
    }
    expect(sink.join("\n")).not.toContain(PROD_TOKEN);
    expect(sink.join("\n")).not.toContain(LOCAL_TOKEN);
  });
});

describe("getAfterGoalStatus (W1636)", () => {
  const originalFetch = globalThis.fetch;
  let captured: { url: string; init: RequestInit } | null = null;

  beforeEach(() => {
    captured = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          after_goal_armed: true,
          goal_id: "4969",
          env: { GOAL_ID: "4969", GOAL_IDENTIFIER: "G227" },
        }),
        { status: 200 },
      );
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("GETs after_goal_status and parses {armed, goalId, env}", async () => {
    const result = await getAfterGoalStatus(
      "https://stride.example.com",
      "test_token_abc123",
      "42",
    );
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe(
      "https://stride.example.com/api/tasks/42/after_goal_status",
    );
    expect(captured!.init.method).toBe("GET");
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test_token_abc123");
    expect(result).toEqual({
      armed: true,
      goalId: "4969",
      env: { GOAL_ID: "4969", GOAL_IDENTIFIER: "G227" },
    });
  });

  it("coerces a numeric goal_id to a string and defaults a missing env to {}", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async () =>
      new Response(JSON.stringify({ after_goal_armed: false, goal_id: 4969 }), {
        status: 200,
      });
    const result = await getAfterGoalStatus("https://stride.example.com", "tok", "42");
    expect(result).toEqual({ armed: false, goalId: "4969", env: {} });
  });

  it("reports armed=false and goalId=null when the server omits them", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async () =>
      new Response(JSON.stringify({ env: { A: "1", B: 2 } }), { status: 200 });
    const result = await getAfterGoalStatus("https://stride.example.com", "tok", "42");
    // armed defaults false, goalId null, and non-string env values are dropped.
    expect(result).toEqual({ armed: false, goalId: null, env: { A: "1" } });
  });

  it("strips a trailing slash from apiBase", async () => {
    await getAfterGoalStatus("https://stride.example.com/", "tok", "42");
    expect(captured!.url).toBe(
      "https://stride.example.com/api/tasks/42/after_goal_status",
    );
  });

  it("no-ops (null) when apiBase, token, or taskId is missing", async () => {
    expect(await getAfterGoalStatus(null, "tok", "42")).toBeNull();
    expect(await getAfterGoalStatus("https://stride.example.com", null, "42")).toBeNull();
    expect(await getAfterGoalStatus("https://stride.example.com", "tok", null)).toBeNull();
    expect(
      await getAfterGoalStatus("https://stride.example.com", "tok", undefined),
    ).toBeNull();
    // None of the prereq-miss paths touch the network.
    expect(captured).toBeNull();
  });

  it("no-ops (null) on a non-2xx response", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async () => new Response("nope", { status: 503 });
    expect(await getAfterGoalStatus("https://stride.example.com", "tok", "42")).toBeNull();
  });

  it("no-ops (null) on a transport error without throwing", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    expect(await getAfterGoalStatus("https://stride.example.com", "tok", "42")).toBeNull();
  });

  it("no-ops (null) on a non-object JSON body", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async () =>
      new Response(JSON.stringify(["not", "an", "object"]), { status: 200 });
    expect(await getAfterGoalStatus("https://stride.example.com", "tok", "42")).toBeNull();
  });

  it("no-ops (null) and never throws on an invalid-JSON body", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async () => new Response("{not json", { status: 200 });
    expect(await getAfterGoalStatus("https://stride.example.com", "tok", "42")).toBeNull();
  });

  it("never leaks the token to stderr on failure", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const sink: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => void sink.push(args.join(" "));
    try {
      await getAfterGoalStatus("https://stride.example.com", "stride_dev_secret", "42");
    } finally {
      console.error = originalError;
    }
    expect(sink.join(" ")).not.toContain("stride_dev_secret");
  });
});

describe("writeCanonicalResponse / readCanonicalResponse (W1636)", () => {
  it("round-trips an arbitrary JSON payload through the nested .stride/ path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stride-canonical-"));
    try {
      const payload = { data: { identifier: "W1636", hooks: [{ name: "after_goal" }] } };
      await writeCanonicalResponse(dir, payload);
      // Bun.write auto-creates the missing .stride/ parent directory.
      expect(existsSync(join(dir, CANONICAL_RESPONSE_FILE))).toBe(true);
      expect(await readCanonicalResponse(dir)).toEqual(payload);
    } finally {
      cleanup(dir);
    }
  });

  it("returns null when the response file is absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stride-canonical-"));
    try {
      expect(await readCanonicalResponse(dir)).toBeNull();
    } finally {
      cleanup(dir);
    }
  });

  it("degrades an invalid-JSON file to null without throwing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stride-canonical-"));
    try {
      mkdirSync(join(dir, ".stride"), { recursive: true });
      writeFileSync(join(dir, CANONICAL_RESPONSE_FILE), "{not json");
      expect(await readCanonicalResponse(dir)).toBeNull();
    } finally {
      cleanup(dir);
    }
  });

  it("the canonical path is excluded from a task's changed_files", async () => {
    const { dir, base } = await initRepo();
    try {
      // Two working-tree changes: a real edit and the canonical capture.
      writeFileSync(join(dir, "a.txt"), "v2\n");
      await writeCanonicalResponse(dir, { data: { identifier: "W1636" } });
      const files = await captureChangedFiles($ as never, dir, base);
      const paths = files.map((f) => f.path);
      expect(paths).toContain("a.txt");
      expect(paths).not.toContain(CANONICAL_RESPONSE_FILE);
    } finally {
      cleanup(dir);
    }
  });
});

// The three-layer after_goal reliability contract at the capture-helper level
// (W1639 / stride W1612): the canonical file is the truncation-proof source,
// and getAfterGoalStatus is the file-independent fresh GET of last resort.
describe("W1639 canonical-file truncation-fallback + fresh-GET contract", () => {
  it("readCanonicalResponse recovers the after_goal payload a truncated output cannot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stride-w1639-"));
    try {
      const full = {
        data: { id: 42 },
        hooks: [
          { name: "after_goal", env: { GOAL_ID: "4969", GOAL_IDENTIFIER: "G227" } },
        ],
      };
      // The agent's API curl tees the FULL response here.
      await writeCanonicalResponse(dir, full);
      // A truncated view of the same response is not parseable on its own...
      const truncated = JSON.stringify(full).slice(0, 30);
      let outputParsed = true;
      try {
        JSON.parse(truncated);
      } catch {
        outputParsed = false;
      }
      expect(outputParsed).toBe(false);
      // ...but the canonical file still yields the full payload, incl after_goal.
      const recovered = (await readCanonicalResponse(dir)) as {
        hooks: { name: string; env: Record<string, string> }[];
      };
      expect(recovered.hooks[0].name).toBe("after_goal");
      expect(recovered.hooks[0].env.GOAL_IDENTIFIER).toBe("G227");
    } finally {
      cleanup(dir);
    }
  });

  it("getAfterGoalStatus is the file-independent fresh GET (stubbed, no file present)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stride-w1639-"));
    const originalFetch = globalThis.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async () =>
      new Response(
        JSON.stringify({ after_goal_armed: true, goal_id: "4969", env: { GOAL_IDENTIFIER: "G227" } }),
        { status: 200 },
      );
    try {
      // No canonical file at all — the fresh GET does not depend on one.
      expect(await readCanonicalResponse(dir)).toBeNull();
      const status = await getAfterGoalStatus("https://stride.example.com", "tok", "42");
      expect(status).toEqual({ armed: true, goalId: "4969", env: { GOAL_IDENTIFIER: "G227" } });
    } finally {
      globalThis.fetch = originalFetch;
      cleanup(dir);
    }
  });
});

/**
 * (D142) Trust guard for the snapshot base ref. These exercise resolveSnapshotBase
 * directly against temp-repo fixtures that reproduce the two-clone cross-pull
 * shape: a bare origin, clone A whose before_doing pull moves HEAD past its
 * claim-time base, and origin/main sitting at the branch point.
 */
describe("resolveSnapshotBase — D142 trust guard", () => {
  // Bare origin + clone A that has pulled another clone's commit (branch point =
  // origin/main) and then made a local task commit on top. Returns the notable
  // commits: prePull (clone A's base before the pull), branchPoint (origin/main
  // after the pull), and taskCommit (HEAD, the local task commit).
  async function crossPullRepo(): Promise<{
    root: string;
    cloneA: string;
    prePull: string;
    branchPoint: string;
    taskCommit: string;
  }> {
    const root = mkdtempSync(join(tmpdir(), "stride-snapbase-"));
    const origin = join(root, "origin.git");
    await $`git init -q --bare ${origin}`.quiet();
    await $`git -C ${origin} symbolic-ref HEAD refs/heads/main`.quiet();
    const cloneA = join(root, "cloneA");
    await $`git clone -q ${origin} ${cloneA}`.quiet();
    await $`git -C ${cloneA} config user.email test@test.local`.quiet();
    await $`git -C ${cloneA} config user.name Test`.quiet();
    await $`git -C ${cloneA} config commit.gpgsign false`.quiet();
    await $`git -C ${cloneA} checkout -q -b main`.nothrow().quiet();
    writeFileSync(join(cloneA, "base.txt"), "base\n");
    await $`git -C ${cloneA} add base.txt`.quiet();
    await $`git -C ${cloneA} commit -q -m base`.quiet();
    await $`git -C ${cloneA} push -q origin main`.quiet();
    const prePull = (await $`git -C ${cloneA} rev-parse HEAD`.quiet())
      .stdout.toString()
      .trim();
    // Clone B pushes another commit.
    const cloneB = join(root, "cloneB");
    await $`git clone -q ${origin} ${cloneB}`.quiet();
    await $`git -C ${cloneB} config user.email test@test.local`.quiet();
    await $`git -C ${cloneB} config user.name Test`.quiet();
    await $`git -C ${cloneB} config commit.gpgsign false`.quiet();
    writeFileSync(join(cloneB, "w1678.txt"), "other\n");
    await $`git -C ${cloneB} add w1678.txt`.quiet();
    await $`git -C ${cloneB} commit -q -m other`.quiet();
    await $`git -C ${cloneB} push -q origin main`.quiet();
    // Clone A pulls (the before_doing pull), then makes a local task commit.
    await $`git -C ${cloneA} pull -q origin main`.quiet();
    const branchPoint = (await $`git -C ${cloneA} rev-parse HEAD`.quiet())
      .stdout.toString()
      .trim();
    writeFileSync(join(cloneA, "task.txt"), "task\n");
    await $`git -C ${cloneA} add task.txt`.quiet();
    await $`git -C ${cloneA} commit -q -m task`.quiet();
    const taskCommit = (await $`git -C ${cloneA} rev-parse HEAD`.quiet())
      .stdout.toString()
      .trim();
    return { root, cloneA, prePull, branchPoint, taskCommit };
  }

  it("recomputes an inherited base older than the branch point to the branch point", async () => {
    const { root, cloneA, prePull, branchPoint } = await crossPullRepo();
    try {
      // prePull is an ancestor of HEAD (so a plain is-ancestor check would trust
      // it — the exact D132 stale base) but predates the branch point.
      const result = await resolveSnapshotBase($, cloneA, prePull, false);
      expect(result).toBe(branchPoint);
    } finally {
      cleanup(root);
    }
  });

  it("passes a TRUSTED base through unchanged (no branch-point second-guessing)", async () => {
    const { root, cloneA, prePull } = await crossPullRepo();
    try {
      // A base this claim's post-before_doing capture wrote (trusted) is the
      // branch point by construction — origin advancing past it must not trigger
      // a recompute (push-before-complete workflows stay safe).
      const result = await resolveSnapshotBase($, cloneA, prePull, true);
      expect(result).toBe(prePull);
    } finally {
      cleanup(root);
    }
  });

  it("passes a base equal to the branch point through unchanged", async () => {
    const { root, cloneA, branchPoint } = await crossPullRepo();
    try {
      const result = await resolveSnapshotBase($, cloneA, branchPoint, false);
      expect(result).toBe(branchPoint);
    } finally {
      cleanup(root);
    }
  });

  it("recomputes an empty base to the branch point", async () => {
    const { root, cloneA, branchPoint } = await crossPullRepo();
    try {
      const result = await resolveSnapshotBase($, cloneA, undefined, false);
      expect(result).toBe(branchPoint);
    } finally {
      cleanup(root);
    }
  });

  it("recomputes an unresolvable base to the branch point", async () => {
    const { root, cloneA, branchPoint } = await crossPullRepo();
    try {
      const result = await resolveSnapshotBase(
        $,
        cloneA,
        "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        false,
      );
      expect(result).toBe(branchPoint);
    } finally {
      cleanup(root);
    }
  });

  it("recomputes a base that is not an ancestor of HEAD to the branch point", async () => {
    const { root, cloneA, branchPoint } = await crossPullRepo();
    try {
      // A commit on a divergent side branch: resolvable, but not an ancestor of
      // HEAD (e.g. a base rebased away).
      await $`git -C ${cloneA} checkout -q -b side`.quiet();
      writeFileSync(join(cloneA, "side.txt"), "side\n");
      await $`git -C ${cloneA} add side.txt`.quiet();
      await $`git -C ${cloneA} commit -q -m side`.quiet();
      const sideCommit = (await $`git -C ${cloneA} rev-parse HEAD`.quiet())
        .stdout.toString()
        .trim();
      await $`git -C ${cloneA} checkout -q main`.quiet();
      const result = await resolveSnapshotBase($, cloneA, sideCommit, false);
      expect(result).toBe(branchPoint);
    } finally {
      cleanup(root);
    }
  });

  it("announces a recompute on stderr", async () => {
    const { root, cloneA, prePull } = await crossPullRepo();
    const origError = console.error;
    const lines: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    console.error = (...args: any[]) => lines.push(args.join(" "));
    try {
      await resolveSnapshotBase($, cloneA, prePull, false);
      expect(
        lines.some((l) => l.includes("recomputed the snapshot base")),
      ).toBe(true);
    } finally {
      console.error = origError;
      cleanup(root);
    }
  });

  it("passes the base through unchanged when the repo has NO origin", async () => {
    // No origin → no branch point to judge against, and no cross-clone pull is
    // possible, so even a bogus base passes through (capture keeps its HEAD~1
    // fallback).
    const { dir } = await initRepo();
    try {
      const bogus = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
      const result = await resolveSnapshotBase($, dir, bogus, false);
      expect(result).toBe(bogus);
    } finally {
      cleanup(dir);
    }
  });

  it("passes the base through unchanged in a non-git directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stride-snapbase-nonrepo-"));
    try {
      const result = await resolveSnapshotBase($, dir, "somebase", false);
      expect(result).toBe("somebase");
    } finally {
      cleanup(dir);
    }
  });
});

describe("recordDiffUploadState / readDiffUploadState — D142 base persistence", () => {
  it("persists and round-trips the resolved snapshot base", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stride-uploadstate-"));
    try {
      await recordDiffUploadState(dir, "42", 200, "abc123def456");
      const state = await readDiffUploadState(dir);
      expect(state).toEqual({
        taskId: "42",
        httpCode: "200",
        base: "abc123def456",
      });
    } finally {
      cleanup(dir);
    }
  });

  it("omits the base line and reports base undefined when no base is given (back-compat)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stride-uploadstate-nobase-"));
    try {
      await recordDiffUploadState(dir, "42", 200);
      const raw = await Bun.file(`${dir}/.stride-diff-upload-state`).text();
      expect(raw).toBe("task_id=42\nhttp_code=200\n");
      const state = await readDiffUploadState(dir);
      expect(state?.base).toBeUndefined();
    } finally {
      cleanup(dir);
    }
  });
});

// (W2150) The loop-state record — the fleet contract stride's Stop gate reads.
describe("writeLoopState / clearLoopState (W2150)", () => {
  function tmp(): string {
    return mkdtempSync(join(tmpdir(), "stride-oc-loop-"));
  }

  const REC = {
    identifier: "W2150",
    needs_review: false,
    completed_at: "2026-08-31T14:03:22Z",
    session_id: "ses_abc",
  };

  it("loopStateSafe accepts the fleet charset and rejects everything else", () => {
    expect(loopStateSafe("W2150")).toBe(true);
    expect(loopStateSafe("ses_a.b:c-d")).toBe(true);
    expect(loopStateSafe("")).toBe(false);
    expect(loopStateSafe("W 2150")).toBe(false);
    expect(loopStateSafe("x".repeat(64))).toBe(true);
    expect(loopStateSafe("x".repeat(65))).toBe(false);
    expect(loopStateSafe(undefined)).toBe(false);
    expect(loopStateSafe(42)).toBe(false);
  });

  it("completedAtNow reproduces `date -u +%Y-%m-%dT%H:%M:%SZ`", () => {
    expect(completedAtNow(new Date("2026-08-31T14:03:22.123Z"))).toBe(
      "2026-08-31T14:03:22Z",
    );
  });

  it("creates .stride/ when absent and leaves no temp file behind", async () => {
    const dir = tmp();
    try {
      expect(existsSync(join(dir, ".stride"))).toBe(false);
      expect(await writeLoopState(dir, REC)).toBe(true);
      const rec = JSON.parse(readFileSync(join(dir, LOOP_STATE_FILE), "utf8"));
      expect(rec.identifier).toBe("W2150");
      expect(rec.needs_review).toBe(false);
      expect(typeof rec.needs_review).toBe("boolean");
      expect(readdirSync(join(dir, ".stride"))).toEqual([".loop-state.json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records needs_review true verbatim as a boolean", async () => {
    const dir = tmp();
    try {
      await writeLoopState(dir, { ...REC, needs_review: true });
      const rec = JSON.parse(readFileSync(join(dir, LOOP_STATE_FILE), "utf8"));
      expect(rec.needs_review).toBe(true);
      expect(typeof rec.needs_review).toBe("boolean");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is never fatal when the write cannot succeed", async () => {
    const dir = tmp();
    try {
      // .stride is a regular file, so mkdirSync throws.
      writeFileSync(join(dir, ".stride"), "not a directory");
      expect(await writeLoopState(dir, REC)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a non-regular destination rather than renaming into it", async () => {
    const dir = tmp();
    try {
      mkdirSync(join(dir, LOOP_STATE_FILE), { recursive: true });
      expect(await writeLoopState(dir, REC)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves no temp file behind when the staging write fails", async () => {
    const dir = tmp();
    try {
      // Reach the catch AFTER `tmp` has been assigned: .stride exists but is
      // not writable, so mkdirSync succeeds (already present) and the staging
      // write throws EACCES. Residual limit, stated rather than implied: the
      // temp is never created on this path, so what this proves is that the
      // cleanup branch runs and leaves nothing — not that an already-created
      // temp is unlinked. Reaching THAT would need a rename stub or a
      // production seam, which a best-effort writer does not justify.
      mkdirSync(join(dir, ".stride"), { recursive: true });
      chmodSync(join(dir, ".stride"), 0o500);
      expect(await writeLoopState(dir, REC)).toBe(false);
      const leftovers = readdirSync(join(dir, ".stride")).filter((f) =>
        /^loop-state\..*\.tmp$/.test(f),
      );
      expect(leftovers).toEqual([]);
    } finally {
      try {
        chmodSync(join(dir, ".stride"), 0o700);
      } catch {
        /* best-effort */
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a claim clears the record, and a missing file is not an error", async () => {
    const dir = tmp();
    try {
      await clearLoopState(dir); // absent — must not throw
      await writeLoopState(dir, REC);
      expect(existsSync(join(dir, LOOP_STATE_FILE))).toBe(true);
      await clearLoopState(dir);
      expect(existsSync(join(dir, LOOP_STATE_FILE))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the loop-state path is excluded from a task's changed_files", async () => {
    const { dir, base } = await initRepo();
    try {
      writeFileSync(join(dir, "a.txt"), "v2\n");
      await writeLoopState(dir, REC);
      // An orphan staging file, as a killed process would leave behind. It is
      // covered by the .stride/ PREFIX skip, not by an exact-match entry.
      writeFileSync(join(dir, ".stride", "loop-state.999.123.abcdef.tmp"), "{}\n");
      const files = await captureChangedFiles($ as never, dir, base);
      const paths = files.map((f) => f.path);
      expect(paths).toContain("a.txt");
      expect(paths).not.toContain(LOOP_STATE_FILE);
      expect(paths.filter((f) => f.startsWith(".stride/"))).toEqual([]);
    } finally {
      cleanup(dir);
    }
  });

  it("matches the fleet record shape every runtime reads", async () => {
    const dir = tmp();
    try {
      await writeLoopState(dir, REC);
      const loopStatePath = join(dir, LOOP_STATE_FILE);

      // (W2150) The record is a FLEET contract: the shell Stop gate, the
      // PowerShell twin and the other port all read this file out of a shared
      // checkout. This block is byte-identical in
      // stride-pi/extensions/hook-bridge/loop-state.test.ts and
      // stride-opencode/src/capture.test.ts (modulo assert vs expect). If one
      // port's writer drifts, exactly one of the two copies fails, and the
      // diff names the drift.
      const parsed = JSON.parse(readFileSync(loopStatePath, "utf8"));
      expect(Object.keys(parsed)).toEqual([
        "identifier",
        "needs_review",
        "completed_at",
        "session_id",
      ]);
      expect(
        Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, typeof v])),
      ).toEqual({
        identifier: "string",
        needs_review: "boolean",
        completed_at: "string",
        session_id: "string",
      });
      expect(parsed.completed_at).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
      );
      expect(parsed.identifier).toMatch(/^[A-Za-z0-9_.:-]{1,64}$/);
      expect(parsed.session_id).toMatch(/^[A-Za-z0-9_.:-]{1,64}$/);
      expect(readFileSync(loopStatePath, "utf8").endsWith("\n")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
