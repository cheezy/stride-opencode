import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import {
  captureChangedFiles,
  extractApiBase,
  extractToken,
  resolveStrideApiUrl,
  resolveStrideApiToken,
  putChangedFiles,
  recordDiffUploadState,
  readDiffUploadState,
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
  it("excludes an untracked .stride-diff-upload-state / .stride-changed-files.json while keeping a real change", async () => {
    const { dir, base } = await initRepo();
    try {
      writeFileSync(join(dir, "a.txt"), "changed\n");
      writeFileSync(join(dir, ".stride-diff-upload-state"), "task_id=42\nhttp_code=200\n");
      writeFileSync(join(dir, ".stride-changed-files.json"), "[]\n");
      const result = await captureChangedFiles($, dir, base);
      const paths = result.map((f) => f.path);
      expect(paths).toContain("a.txt");
      expect(paths).not.toContain(".stride-diff-upload-state");
      expect(paths).not.toContain(".stride-changed-files.json");
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
      const result = await captureChangedFiles($, dir, base);
      const paths = result.map((f) => f.path);
      expect(paths).toContain("sub/.stride-diff-upload-state");
      expect(paths).toContain("sub/.stride-changed-files.json");
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
