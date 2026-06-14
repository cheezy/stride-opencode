import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import {
  parseStrideMd,
  filterCommands,
  detectHook,
  extractCommand,
  extractToolName,
  extractToolArgs,
  extractEnvFromResponse,
  responseHasAfterGoal,
  StridePlugin,
} from "./index";

// --- parseStrideMd tests ---

describe("parseStrideMd", () => {
  const sampleMd = `# Stride Configuration

## before_doing

\`\`\`bash
git pull origin main
mix deps.get
mix ecto.migrate
\`\`\`

## after_doing

\`\`\`bash
mix test --cover
mix format --check-formatted
mix credo --strict
mix sobelow --config .sobelow_config.exs
\`\`\`

## before_review

\`\`\`bash
git fetch origin
git rebase origin/main
mix test
\`\`\`

## after_review

\`\`\`bash
git fetch origin
git rebase origin/main
mix test
git push origin main
\`\`\`
`;

  it("extracts before_doing commands", () => {
    const commands = parseStrideMd(sampleMd, "before_doing");
    expect(commands).toEqual([
      "git pull origin main",
      "mix deps.get",
      "mix ecto.migrate",
    ]);
  });

  it("extracts after_doing commands", () => {
    const commands = parseStrideMd(sampleMd, "after_doing");
    expect(commands).toEqual([
      "mix test --cover",
      "mix format --check-formatted",
      "mix credo --strict",
      "mix sobelow --config .sobelow_config.exs",
    ]);
  });

  it("extracts before_review commands", () => {
    const commands = parseStrideMd(sampleMd, "before_review");
    expect(commands).toEqual([
      "git fetch origin",
      "git rebase origin/main",
      "mix test",
    ]);
  });

  it("extracts after_review commands", () => {
    const commands = parseStrideMd(sampleMd, "after_review");
    expect(commands).toEqual([
      "git fetch origin",
      "git rebase origin/main",
      "mix test",
      "git push origin main",
    ]);
  });

  it("returns empty array for missing section", () => {
    const commands = parseStrideMd(sampleMd, "before_doing" as never);
    // Test a hook name that doesn't exist
    const result = parseStrideMd("## other\n\n```bash\nfoo\n```", "before_doing");
    expect(result).toEqual([]);
  });

  it("handles CRLF line endings", () => {
    const crlfMd = "## before_doing\r\n\r\n```bash\r\ngit pull\r\nmix deps.get\r\n```\r\n";
    const commands = parseStrideMd(crlfMd, "before_doing");
    expect(commands).toEqual(["git pull", "mix deps.get"]);
  });

  it("handles no trailing newline", () => {
    const md = "## before_doing\n\n```bash\ngit pull\n```";
    const commands = parseStrideMd(md, "before_doing");
    expect(commands).toEqual(["git pull"]);
  });

  it("handles empty code blocks", () => {
    const md = "## before_doing\n\n```bash\n```\n";
    const commands = parseStrideMd(md, "before_doing");
    expect(commands).toEqual([]);
  });

  it("handles adjacent sections", () => {
    const md = "## before_doing\n\n```bash\ncmd1\n```\n## after_doing\n\n```bash\ncmd2\n```\n";
    expect(parseStrideMd(md, "before_doing")).toEqual(["cmd1"]);
    expect(parseStrideMd(md, "after_doing")).toEqual(["cmd2"]);
  });

  it("handles .stride.md with only some hooks defined", () => {
    const md = "## before_doing\n\n```bash\ngit pull\n```\n";
    expect(parseStrideMd(md, "before_doing")).toEqual(["git pull"]);
    expect(parseStrideMd(md, "after_doing")).toEqual([]);
    expect(parseStrideMd(md, "before_review")).toEqual([]);
    expect(parseStrideMd(md, "after_review")).toEqual([]);
  });

  it("filters comments and blank lines from commands", () => {
    const md = "## before_doing\n\n```bash\n# this is a comment\ngit pull\n\n# another comment\nmix deps.get\n```\n";
    const commands = parseStrideMd(md, "before_doing");
    expect(commands).toEqual(["git pull", "mix deps.get"]);
  });
});

// --- filterCommands tests ---

describe("filterCommands", () => {
  it("removes empty lines", () => {
    expect(filterCommands(["cmd1", "", "cmd2", "  "])).toEqual([
      "cmd1",
      "cmd2",
    ]);
  });

  it("removes comment lines", () => {
    expect(filterCommands(["# comment", "cmd1", "# another"])).toEqual([
      "cmd1",
    ]);
  });

  it("trims whitespace", () => {
    expect(filterCommands(["  cmd1  ", "\tcmd2\t"])).toEqual(["cmd1", "cmd2"]);
  });

  it("returns empty array for all comments", () => {
    expect(filterCommands(["# comment", "# another"])).toEqual([]);
  });
});

// --- detectHook tests ---

describe("detectHook", () => {
  // after + claim → before_doing
  it("routes after+claim to before_doing", () => {
    expect(
      detectHook(
        "after",
        'curl -X POST https://stride.dev/api/tasks/claim -d \'{"identifier":"W1"}\'',
      ),
    ).toBe("before_doing");
  });

  // pre + complete → after_doing
  it("routes before+complete to after_doing", () => {
    expect(
      detectHook(
        "before",
        "curl -X PATCH https://stride.dev/api/tasks/123/complete",
      ),
    ).toBe("after_doing");
  });

  // after + complete → before_review
  it("routes after+complete to before_review", () => {
    expect(
      detectHook(
        "after",
        "curl -X PATCH https://stride.dev/api/tasks/123/complete -d '{}'",
      ),
    ).toBe("before_review");
  });

  // after + mark_reviewed → after_review
  it("routes after+mark_reviewed to after_review", () => {
    expect(
      detectHook(
        "after",
        "curl -X PATCH https://stride.dev/api/tasks/456/mark_reviewed",
      ),
    ).toBe("after_review");
  });

  // mark_reviewed must match before complete (both have /api/tasks/:id/)
  it("prioritizes mark_reviewed over complete pattern", () => {
    expect(
      detectHook(
        "after",
        "curl https://stride.dev/api/tasks/99/mark_reviewed -d '{}'",
      ),
    ).toBe("after_review");
  });

  // Non-Stride commands return null
  it("returns null for non-Stride commands", () => {
    expect(detectHook("after", "mix test")).toBeNull();
    expect(detectHook("before", "git pull")).toBeNull();
    expect(detectHook("after", "curl https://example.com/api")).toBeNull();
  });

  // pre + claim → null (only after triggers before_doing)
  it("returns null for before+claim", () => {
    expect(
      detectHook("before", "curl -X POST https://stride.dev/api/tasks/claim"),
    ).toBeNull();
  });

  // pre + mark_reviewed → null
  it("returns null for before+mark_reviewed", () => {
    expect(
      detectHook(
        "before",
        "curl https://stride.dev/api/tasks/99/mark_reviewed",
      ),
    ).toBeNull();
  });
});

// --- tool payload extraction helpers ---

describe("extractCommand", () => {
  it("reads the command from the nested .input shape", () => {
    expect(extractCommand({ input: { command: "curl -X POST /claim" } })).toBe(
      "curl -X POST /claim",
    );
  });

  it("falls back to the first positional arg when command is absent", () => {
    expect(extractCommand({ input: { args: ["git status", "-s"] } })).toBe(
      "git status",
    );
  });

  it("prefers command over args[0] when both are present", () => {
    expect(
      extractCommand({ input: { command: "cmd", args: ["argcmd"] } }),
    ).toBe("cmd");
  });

  it("returns empty string for an empty command (falls through to args)", () => {
    expect(extractCommand({ input: { command: "", args: ["fallback"] } })).toBe(
      "fallback",
    );
  });

  it("returns empty string when there is no command or args", () => {
    expect(extractCommand({ input: {} })).toBe("");
    expect(extractCommand({})).toBe("");
    expect(extractCommand(undefined)).toBe("");
    expect(extractCommand(null)).toBe("");
  });
});

describe("extractToolName", () => {
  it("reads tool from the SDK-flat shape", () => {
    expect(extractToolName({ tool: "bash" })).toBe("bash");
  });

  it("reads tool from the nested .input shape", () => {
    expect(extractToolName({ input: { tool: "skill" } })).toBe("skill");
  });

  it("prefers the flat tool over the nested one", () => {
    expect(extractToolName({ tool: "flat", input: { tool: "nested" } })).toBe(
      "flat",
    );
  });

  it("does not fall through on an empty-string tool (?? semantics)", () => {
    expect(extractToolName({ tool: "", input: { tool: "nested" } })).toBe("");
  });

  it("returns empty string when no tool is present", () => {
    expect(extractToolName({})).toBe("");
    expect(extractToolName(undefined)).toBe("");
    expect(extractToolName(null)).toBe("");
  });
});

describe("extractToolArgs", () => {
  it("reads args from the output object first", () => {
    expect(extractToolArgs({}, { args: { name: "x" } })).toEqual({ name: "x" });
  });

  it("falls back to the nested input payload when output has no args", () => {
    expect(extractToolArgs({ input: { skill: "y" } }, {})).toEqual({
      skill: "y",
    });
  });

  it("prefers output.args over the nested input payload", () => {
    expect(
      extractToolArgs({ input: { skill: "nested" } }, { args: "fromOutput" }),
    ).toBe("fromOutput");
  });

  it("returns undefined when neither source provides args", () => {
    expect(extractToolArgs({}, {})).toBeUndefined();
    expect(extractToolArgs(undefined, undefined)).toBeUndefined();
    expect(extractToolArgs(null, null)).toBeUndefined();
  });
});

// --- extractEnvFromResponse tests ---

describe("extractEnvFromResponse", () => {
  it("extracts task metadata from wrapped response", () => {
    const response = JSON.stringify({
      data: {
        id: 42,
        identifier: "W42",
        title: "Test task",
        status: "in_progress",
        complexity: "medium",
        priority: "high",
        needs_review: false,
        description: "A test task",
      },
    });

    const env = extractEnvFromResponse(response);
    expect(env.TASK_ID).toBe("42");
    expect(env.TASK_IDENTIFIER).toBe("W42");
    expect(env.TASK_TITLE).toBe("Test task");
    expect(env.TASK_STATUS).toBe("in_progress");
    expect(env.TASK_COMPLEXITY).toBe("medium");
    expect(env.TASK_PRIORITY).toBe("high");
    expect(env.TASK_NEEDS_REVIEW).toBe("false");
    expect(env.TASK_DESCRIPTION).toBe("A test task");
  });

  it("extracts from unwrapped response (no data key)", () => {
    const response = JSON.stringify({
      id: 99,
      identifier: "W99",
      title: "Direct",
    });

    const env = extractEnvFromResponse(response);
    expect(env.TASK_ID).toBe("99");
    expect(env.TASK_IDENTIFIER).toBe("W99");
  });

  it("returns empty object for non-JSON", () => {
    const env = extractEnvFromResponse("not json");
    expect(Object.keys(env)).toHaveLength(0);
  });

  it("returns empty object for empty string", () => {
    const env = extractEnvFromResponse("");
    expect(Object.keys(env)).toHaveLength(0);
  });

  it("handles missing optional fields", () => {
    const response = JSON.stringify({ data: { id: 1 } });
    const env = extractEnvFromResponse(response);
    expect(env.TASK_ID).toBe("1");
    expect(env.TASK_IDENTIFIER).toBeUndefined();
  });

  it("extracts from host wrapper with .stdout (Bash tool shape)", () => {
    // Some hosts (e.g. Claude Code's Bash tool) wrap the API response as
    // {"stdout":"<api-json-string>","stderr":"...",...}. The API JSON we
    // want lives inside .stdout as a string and must be parsed again.
    const response = JSON.stringify({
      stdout: JSON.stringify({
        data: {
          id: 1526,
          identifier: "W217",
          title: "Wrapped Task",
          status: "in_progress",
          complexity: "medium",
          priority: "high",
        },
      }),
      stderr: "",
      interrupted: false,
    });
    const env = extractEnvFromResponse(response);
    expect(env.TASK_ID).toBe("1526");
    expect(env.TASK_IDENTIFIER).toBe("W217");
    expect(env.TASK_TITLE).toBe("Wrapped Task");
    expect(env.TASK_STATUS).toBe("in_progress");
  });

  it("extracts from host wrapper with unwrapped inner payload", () => {
    const response = JSON.stringify({
      stdout: JSON.stringify({ id: 7, identifier: "W7", title: "Flat" }),
    });
    const env = extractEnvFromResponse(response);
    expect(env.TASK_ID).toBe("7");
    expect(env.TASK_IDENTIFIER).toBe("W7");
  });
});

// --- responseHasAfterGoal tests (W794 / mirrors W506 Group 9) ---

describe("responseHasAfterGoal", () => {
  // Build the Claude/Gemini-style Bash-tool wrapper transport shape.
  const buildWrapped = (hooks: Array<{ name: string }>) =>
    JSON.stringify({
      stdout: JSON.stringify({ data: { id: 42 }, hooks }),
    });

  // Build a raw payload (no wrapper) — third transport shape.
  const buildRaw = (hooks: Array<{ name: string }>) =>
    JSON.stringify({ data: { id: 42 }, hooks });

  it("returns true when after_goal is in the wrapped Bash-tool stdout payload", () => {
    const input = buildWrapped([
      { name: "before_review" },
      { name: "after_review" },
      { name: "after_goal" },
    ]);
    expect(responseHasAfterGoal(input)).toBe(true);
  });

  it("returns true when after_goal is in the raw API JSON payload", () => {
    const input = buildRaw([{ name: "before_review" }, { name: "after_goal" }]);
    expect(responseHasAfterGoal(input)).toBe(true);
  });

  it("returns false when after_goal is absent from the hooks array", () => {
    const input = buildWrapped([
      { name: "before_review" },
      { name: "after_review" },
    ]);
    expect(responseHasAfterGoal(input)).toBe(false);
  });

  it("returns false when the hooks array is empty", () => {
    const input = buildWrapped([]);
    expect(responseHasAfterGoal(input)).toBe(false);
  });

  it("returns false when the hooks key is missing entirely", () => {
    const input = JSON.stringify({
      stdout: JSON.stringify({ data: { id: 42 } }),
    });
    expect(responseHasAfterGoal(input)).toBe(false);
  });

  it("returns false on malformed outer JSON", () => {
    expect(responseHasAfterGoal("not json at all {{")).toBe(false);
  });

  it("returns false on malformed inner stdout JSON (falls back to outer parse)", () => {
    // Outer parses fine; the inner .stdout string fails to parse — code
    // should fall back to using the outer parsed object (which has no
    // .hooks at top level), then return false cleanly.
    const input = JSON.stringify({ stdout: "this is not json {{" });
    expect(responseHasAfterGoal(input)).toBe(false);
  });

  it("returns false when output is null or undefined", () => {
    expect(responseHasAfterGoal(null)).toBe(false);
    expect(responseHasAfterGoal(undefined)).toBe(false);
  });

  it("handles object output with .output wrapping a JSON string", () => {
    // opencode's tool.execute.after delivers `output` as an object whose
    // .output is the response string. Detection must peel that layer.
    const input = {
      output: buildWrapped([{ name: "after_goal" }]),
    };
    expect(responseHasAfterGoal(input)).toBe(true);
  });

  it("handles object output with .result wrapping a JSON string", () => {
    // Alternate wrap shape (.result instead of .output).
    const input = {
      result: buildRaw([{ name: "after_goal" }]),
    };
    expect(responseHasAfterGoal(input)).toBe(true);
  });

  it("handles raw object output with .hooks at top level (no wrapper)", () => {
    // Edge case: output is the parsed payload object directly, with .hooks
    // accessible at the top level. JSON.stringify it and parse back through
    // the same path.
    const input = { data: { id: 42 }, hooks: [{ name: "after_goal" }] };
    expect(responseHasAfterGoal(input)).toBe(true);
  });

  it("ignores non-object entries in the hooks array", () => {
    // Defensive: a hooks array containing nulls/strings shouldn't crash.
    const input = JSON.stringify({
      stdout: JSON.stringify({
        hooks: [null, "after_goal", { name: "after_goal" }],
      }),
    });
    expect(responseHasAfterGoal(input)).toBe(true);
  });
});

// --- StridePlugin W1093/W1094: diff-upload survives an after_doing timeout ---
//
// These instantiate the plugin factory with a real git temp repo, a real bun
// `$`, and a stubbed global fetch that records the changed_files PUT calls and
// returns a configurable status. They drive the tool.execute.before/after
// handlers to exercise the early-capture (W1093) and self-heal (W1094) paths.

describe("StridePlugin — W1093 early capture + W1094 self-heal", () => {
  const originalFetch = globalThis.fetch;
  let putCalls: string[] = [];
  let nextStatus = 200;

  function stubFetch(): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async (url: string) => {
      if (typeof url === "string" && url.includes("/changed_files")) {
        putCalls.push(url);
      }
      return new Response("", { status: nextStatus });
    };
  }

  beforeEach(() => {
    putCalls = [];
    nextStatus = 200;
    stubFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  async function initRepo(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "stride-oc-plugin-"));
    await $`git init -q`.cwd(dir).quiet();
    await $`git config user.email "test@test.local"`.cwd(dir).quiet();
    await $`git config user.name "Test"`.cwd(dir).quiet();
    writeFileSync(join(dir, ".gitignore"), ".stride.md\n.stride-changed-files.json\n.stride-diff-upload-state\nearly-snapshot.json\n");
    writeFileSync(join(dir, "tracked.txt"), "v1\n");
    await $`git add .gitignore tracked.txt`.cwd(dir).quiet();
    await $`git commit -q -m v1`.cwd(dir).quiet();
    return dir;
  }

  function cleanup(dir: string): void {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  const CLAIM_CMD = "curl -X POST http://localhost/api/tasks/claim";
  // A /complete command carrying the URL + token literals so resolveStrideApiUrl
  // / resolveStrideApiToken succeed with no .stride_auth.md present.
  const COMPLETE_CMD =
    'curl -X PATCH http://localhost/api/tasks/42/complete -H "Authorization: Bearer tok"';
  const CLAIM_RESPONSE = JSON.stringify({
    data: { id: 42, identifier: "W42", title: "T", status: "in_progress" },
  });

  async function instantiate(dir: string) {
    const hooks = await StridePlugin({ directory: dir, worktree: dir, $ } as never);
    return hooks as {
      "tool.execute.before": (i: unknown, o?: unknown) => Promise<void>;
      "tool.execute.after": (i: unknown, o?: unknown) => Promise<void>;
    };
  }

  it("W1093: an empty after_doing section still captures + uploads + records state", async () => {
    const dir = await initRepo();
    try {
      const hooks = await instantiate(dir);
      // Claim populates envCache (TASK_ID=42) + TASK_BASE_REF.
      await hooks["tool.execute.after"]({ input: { command: CLAIM_CMD } }, CLAIM_RESPONSE);
      putCalls = [];
      // Empty after_doing section → finalizeAfterDoing runs on the no-commands
      // path (no executeCommands), writing the snapshot, PUTting it, recording.
      writeFileSync(join(dir, ".stride.md"), "## after_doing\n\n```bash\n```\n");
      await hooks["tool.execute.before"]({ input: { command: COMPLETE_CMD } });
      expect(existsSync(join(dir, ".stride-changed-files.json"))).toBe(true);
      expect(putCalls.length).toBe(1);
      const state = readFileSync(join(dir, ".stride-diff-upload-state"), "utf8");
      expect(state).toBe("task_id=42\nhttp_code=200\n");
    } finally {
      cleanup(dir);
    }
  });

  it("W1093: early snapshot + PUT survive a FAILING after_doing gate (uploaded before the gate completes)", async () => {
    const dir = await initRepo();
    try {
      const hooks = await instantiate(dir);
      await hooks["tool.execute.after"]({ input: { command: CLAIM_CMD } }, CLAIM_RESPONSE);
      putCalls = [];
      writeFileSync(
        join(dir, ".stride.md"),
        "## after_doing\n\n```bash\nbash -c 'exit 7'\n```\n",
      );
      // The before-handler throws to block completion on a failed gate.
      let threw = false;
      try {
        await hooks["tool.execute.before"]({ input: { command: COMPLETE_CMD } });
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
      // The early PUT already happened before the gate ran/failed — so a slow or
      // failing after_doing gate can no longer lose the diff. Exactly one PUT
      // (the post-commands refresh is skipped because the gate failed).
      expect(putCalls.length).toBe(1);
      expect(existsSync(join(dir, ".stride-changed-files.json"))).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  it("W1094: before_review re-uploads when NO state is on record", async () => {
    const dir = await initRepo();
    try {
      const hooks = await instantiate(dir);
      await hooks["tool.execute.after"]({ input: { command: CLAIM_CMD } }, CLAIM_RESPONSE);
      putCalls = []; // ignore any claim-path activity
      await hooks["tool.execute.after"]({ input: { command: COMPLETE_CMD } }, "");
      expect(putCalls.length).toBe(1);
      const state = readFileSync(join(dir, ".stride-diff-upload-state"), "utf8");
      expect(state).toBe("task_id=42\nhttp_code=200\n");
    } finally {
      cleanup(dir);
    }
  });

  it("W1094: before_review does NOT re-upload on a healthy 2xx for the current task", async () => {
    const dir = await initRepo();
    try {
      const hooks = await instantiate(dir);
      await hooks["tool.execute.after"]({ input: { command: CLAIM_CMD } }, CLAIM_RESPONSE);
      writeFileSync(join(dir, ".stride-diff-upload-state"), "task_id=42\nhttp_code=200\n");
      putCalls = [];
      await hooks["tool.execute.after"]({ input: { command: COMPLETE_CMD } }, "");
      expect(putCalls.length).toBe(0);
    } finally {
      cleanup(dir);
    }
  });

  it("W1094: before_review re-uploads when state names a DIFFERENT task", async () => {
    const dir = await initRepo();
    try {
      const hooks = await instantiate(dir);
      await hooks["tool.execute.after"]({ input: { command: CLAIM_CMD } }, CLAIM_RESPONSE);
      writeFileSync(join(dir, ".stride-diff-upload-state"), "task_id=41\nhttp_code=200\n");
      putCalls = [];
      await hooks["tool.execute.after"]({ input: { command: COMPLETE_CMD } }, "");
      expect(putCalls.length).toBe(1);
      const state = readFileSync(join(dir, ".stride-diff-upload-state"), "utf8");
      expect(state).toBe("task_id=42\nhttp_code=200\n");
    } finally {
      cleanup(dir);
    }
  });

  it("W1094: before_review re-uploads on a recorded non-2xx for the current task", async () => {
    const dir = await initRepo();
    try {
      const hooks = await instantiate(dir);
      await hooks["tool.execute.after"]({ input: { command: CLAIM_CMD } }, CLAIM_RESPONSE);
      writeFileSync(join(dir, ".stride-diff-upload-state"), "task_id=42\nhttp_code=503\n");
      putCalls = [];
      await hooks["tool.execute.after"]({ input: { command: COMPLETE_CMD } }, "");
      expect(putCalls.length).toBe(1);
    } finally {
      cleanup(dir);
    }
  });

  it("W1094: claim refresh clears a prior task's upload state", async () => {
    const dir = await initRepo();
    try {
      const hooks = await instantiate(dir);
      writeFileSync(join(dir, ".stride-diff-upload-state"), "task_id=41\nhttp_code=200\n");
      await hooks["tool.execute.after"]({ input: { command: CLAIM_CMD } }, CLAIM_RESPONSE);
      expect(existsSync(join(dir, ".stride-diff-upload-state"))).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  it("W1094: after_review cleanup removes the upload state", async () => {
    const dir = await initRepo();
    try {
      const hooks = await instantiate(dir);
      await hooks["tool.execute.after"]({ input: { command: CLAIM_CMD } }, CLAIM_RESPONSE);
      writeFileSync(join(dir, ".stride-diff-upload-state"), "task_id=42\nhttp_code=200\n");
      // A .stride.md must exist (real usage always has one) so the after-handler
      // reaches the after_review cleanup rather than the no-.stride.md early
      // return. No after_review section ⇒ no commands run.
      writeFileSync(join(dir, ".stride.md"), "## before_doing\n\n```bash\necho hi\n```\n");
      const reviewCmd = "curl -X PATCH http://localhost/api/tasks/42/mark_reviewed";
      await hooks["tool.execute.after"]({ input: { command: reviewCmd } }, "");
      expect(existsSync(join(dir, ".stride-diff-upload-state"))).toBe(false);
    } finally {
      cleanup(dir);
    }
  });
});
