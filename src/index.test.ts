import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import {
  parseStrideMd,
  filterCommands,
  detectHook,
  taskIdFromCommand,
  extractCommand,
  extractToolName,
  extractToolArgs,
  extractEnvFromResponse,
  extractHookEnvFromResponse,
  coerceOutputText,
  peelPayloadRoot,
  responseHasAfterGoal,
  CANONICAL_RESPONSE_FILE,
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

// --- URL -> task id extraction (D127) ---

describe("taskIdFromCommand", () => {
  it("extracts the numeric id from a /complete command URL", () => {
    expect(
      taskIdFromCommand(
        "curl -X PATCH https://stride.dev/api/tasks/123/complete -d '{}'",
      ),
    ).toBe("123");
  });

  it("extracts the numeric id from a /mark_reviewed command URL", () => {
    expect(
      taskIdFromCommand(
        "curl -X PATCH https://stride.dev/api/tasks/456/mark_reviewed",
      ),
    ).toBe("456");
  });

  it("returns null for the claim path (no id in the URL)", () => {
    expect(
      taskIdFromCommand("curl -X POST https://stride.dev/api/tasks/claim"),
    ).toBeNull();
  });

  it("returns null for the next path (no id in the URL)", () => {
    expect(
      taskIdFromCommand("curl https://stride.dev/api/tasks/next"),
    ).toBeNull();
  });

  it("returns null for a non-numeric id segment", () => {
    expect(
      taskIdFromCommand("curl -X PATCH https://stride.dev/api/tasks/abc/complete"),
    ).toBeNull();
  });

  it("returns null for a non-Stride command", () => {
    expect(taskIdFromCommand("git status")).toBeNull();
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
      expect(state).toMatch(/^task_id=42\nhttp_code=200\nbase=[0-9a-f]{40}\n$/);
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
      expect(state).toMatch(/^task_id=42\nhttp_code=200\nbase=[0-9a-f]{40}\n$/);
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
      expect(state).toMatch(/^task_id=42\nhttp_code=200\nbase=[0-9a-f]{40}\n$/);
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

  // A claim response carrying a STALE task id (41) — e.g. a corrupted or piped
  // claim capture from a prior task — while the /complete command carries the
  // authoritative id (42) in its URL.
  const STALE_CLAIM_RESPONSE = JSON.stringify({
    data: { id: 41, identifier: "W41", title: "T", status: "in_progress" },
  });

  it("D127: after_doing finalize PUT targets the /complete URL id, not a stale env TASK_ID", async () => {
    const dir = await initRepo();
    try {
      const hooks = await instantiate(dir);
      await hooks["tool.execute.after"]({ input: { command: CLAIM_CMD } }, STALE_CLAIM_RESPONSE);
      putCalls = [];
      writeFileSync(join(dir, ".stride.md"), "## after_doing\n\n```bash\n```\n");
      await hooks["tool.execute.before"]({ input: { command: COMPLETE_CMD } });
      expect(putCalls.length).toBe(1);
      expect(putCalls[0]).toContain("/api/tasks/42/changed_files");
      expect(putCalls[0]).not.toContain("/api/tasks/41/");
      const state = readFileSync(join(dir, ".stride-diff-upload-state"), "utf8");
      expect(state).toMatch(/^task_id=42\nhttp_code=200\nbase=[0-9a-f]{40}\n$/);
    } finally {
      cleanup(dir);
    }
  });

  it("D127: before_review self-heal PUT targets the /complete URL id, not a stale env TASK_ID", async () => {
    const dir = await initRepo();
    try {
      const hooks = await instantiate(dir);
      await hooks["tool.execute.after"]({ input: { command: CLAIM_CMD } }, STALE_CLAIM_RESPONSE);
      putCalls = []; // ignore any claim-path activity
      // No healthy state on record → before_review self-heals; the re-PUT must
      // target the URL id 42, not the stale env id 41.
      await hooks["tool.execute.after"]({ input: { command: COMPLETE_CMD } }, "");
      expect(putCalls.length).toBe(1);
      expect(putCalls[0]).toContain("/api/tasks/42/changed_files");
      expect(putCalls[0]).not.toContain("/api/tasks/41/");
      const state = readFileSync(join(dir, ".stride-diff-upload-state"), "utf8");
      expect(state).toMatch(/^task_id=42\nhttp_code=200\nbase=[0-9a-f]{40}\n$/);
    } finally {
      cleanup(dir);
    }
  });

  it("W1658: a terminal non-2xx self-heal PUT logs UNRESOLVED, marks the state file, and never vetoes completion", async () => {
    const dir = await initRepo();
    const origError = console.error;
    const errLines: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    console.error = (...args: any[]) => {
      errLines.push(args.join(" "));
    };
    try {
      const hooks = await instantiate(dir);
      await hooks["tool.execute.after"]({ input: { command: CLAIM_CMD } }, CLAIM_RESPONSE);
      putCalls = [];
      nextStatus = 500; // force the before_review self-heal PUT to fail terminally
      // before_review runs on the tool.execute.after pass over the /complete
      // command; with no healthy state on record it self-heals, PUTs 500.
      let threw = false;
      try {
        await hooks["tool.execute.after"]({ input: { command: COMPLETE_CMD } }, "");
      } catch {
        threw = true;
      }
      expect(threw).toBe(false); // fail-soft — the completion is never vetoed
      expect(putCalls.length).toBe(1);
      // The record write (overwrite) plus the appended unresolved marker.
      const state = readFileSync(join(dir, ".stride-diff-upload-state"), "utf8");
      expect(state).toMatch(
        /^task_id=42\nhttp_code=500\nbase=[0-9a-f]{40}\nunresolved=yes\n$/,
      );
      // The distinct terminal message (separate from the per-attempt warning).
      expect(
        errLines.some((l) =>
          l.includes("CHANGED_FILES UPLOAD UNRESOLVED for task 42 (HTTP 500)"),
        ),
      ).toBe(true);
    } finally {
      console.error = origError;
      cleanup(dir);
    }
  });

  it("W1658: a 2xx self-heal PUT (incl. a legitimately-empty diff) takes the success path — no UNRESOLVED, no marker", async () => {
    const dir = await initRepo();
    const origError = console.error;
    const errLines: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    console.error = (...args: any[]) => {
      errLines.push(args.join(" "));
    };
    try {
      const hooks = await instantiate(dir);
      await hooks["tool.execute.after"]({ input: { command: CLAIM_CMD } }, CLAIM_RESPONSE);
      putCalls = [];
      nextStatus = 200; // healthy upload
      await hooks["tool.execute.after"]({ input: { command: COMPLETE_CMD } }, "");
      expect(putCalls.length).toBe(1);
      const state = readFileSync(join(dir, ".stride-diff-upload-state"), "utf8");
      expect(state).toMatch(/^task_id=42\nhttp_code=200\nbase=[0-9a-f]{40}\n$/); // no unresolved marker
      expect(errLines.some((l) => l.includes("UNRESOLVED"))).toBe(false);
    } finally {
      console.error = origError;
      cleanup(dir);
    }
  });

  it("W1658: a later 2xx PUT overwrites the state file and self-clears the unresolved mark", async () => {
    const dir = await initRepo();
    try {
      const hooks = await instantiate(dir);
      await hooks["tool.execute.after"]({ input: { command: CLAIM_CMD } }, CLAIM_RESPONSE);
      // First self-heal fails terminally → marks unresolved.
      nextStatus = 500;
      await hooks["tool.execute.after"]({ input: { command: COMPLETE_CMD } }, "");
      expect(
        readFileSync(join(dir, ".stride-diff-upload-state"), "utf8"),
      ).toContain("unresolved=yes");
      // A later self-heal lands 2xx → recordDiffUploadState overwrites the whole
      // file, so the unresolved mark self-clears.
      nextStatus = 200;
      await hooks["tool.execute.after"]({ input: { command: COMPLETE_CMD } }, "");
      const state = readFileSync(join(dir, ".stride-diff-upload-state"), "utf8");
      expect(state).toMatch(/^task_id=42\nhttp_code=200\nbase=[0-9a-f]{40}\n$/);
      expect(state).not.toContain("unresolved");
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

  it("D142: two-clone cross-pull — the claim captures the POST-pull base and the completed snapshot excludes the other clone's pulled file", async () => {
    const root = mkdtempSync(join(tmpdir(), "stride-oc-d142-"));
    try {
      const origin = join(root, "origin.git");
      await $`git init -q --bare ${origin}`.quiet();
      await $`git -C ${origin} symbolic-ref HEAD refs/heads/main`.quiet();
      const cloneA = join(root, "cloneA");
      await $`git clone -q ${origin} ${cloneA}`.quiet();
      await $`git -C ${cloneA} config user.email test@test.local`.quiet();
      await $`git -C ${cloneA} config user.name Test`.quiet();
      await $`git -C ${cloneA} config commit.gpgsign false`.quiet();
      await $`git -C ${cloneA} checkout -q -b main`.nothrow().quiet();
      writeFileSync(
        join(cloneA, ".gitignore"),
        ".stride.md\n.stride-changed-files.json\n.stride-diff-upload-state\n.stride-env-cache\n",
      );
      writeFileSync(join(cloneA, "base.txt"), "base\n");
      await $`git -C ${cloneA} add .gitignore base.txt`.quiet();
      await $`git -C ${cloneA} commit -q -m base`.quiet();
      await $`git -C ${cloneA} push -q origin main`.quiet();
      // Clone B (another computer) pushes a completed task.
      const cloneB = join(root, "cloneB");
      await $`git clone -q ${origin} ${cloneB}`.quiet();
      await $`git -C ${cloneB} config user.email test@test.local`.quiet();
      await $`git -C ${cloneB} config user.name Test`.quiet();
      await $`git -C ${cloneB} config commit.gpgsign false`.quiet();
      writeFileSync(join(cloneB, "w1678.txt"), "other\n");
      await $`git -C ${cloneB} add w1678.txt`.quiet();
      await $`git -C ${cloneB} commit -q -m other`.quiet();
      await $`git -C ${cloneB} push -q origin main`.quiet();
      // Clone A's before_doing pulls; after_doing commits the task work.
      writeFileSync(
        join(cloneA, ".stride.md"),
        "## before_doing\n\n```bash\ngit pull -q origin main\n```\n\n## after_doing\n\n```bash\ngit add -A\ngit commit -q -m task\n```\n",
      );
      // A stale base from a "previous session" that MUST be replaced.
      writeFileSync(
        join(cloneA, ".stride-env-cache"),
        '{"TASK_ID":"OLD1","TASK_BASE_REF":"1111111111111111111111111111111111111111"}\n',
      );
      const prePull = (await $`git -C ${cloneA} rev-parse HEAD`.quiet())
        .stdout.toString()
        .trim();
      const hooks = await instantiate(cloneA);
      // Claim → runs the before_doing pull, then finalizeBeforeDoing (post-section).
      await hooks["tool.execute.after"](
        { input: { command: CLAIM_CMD } },
        CLAIM_RESPONSE,
      );
      const postPull = (await $`git -C ${cloneA} rev-parse HEAD`.quiet())
        .stdout.toString()
        .trim();
      // Fixture discriminating power: the pull actually moved HEAD.
      expect(postPull).not.toBe(prePull);
      const cache = JSON.parse(
        readFileSync(join(cloneA, ".stride-env-cache"), "utf8"),
      );
      expect(cache.TASK_BASE_REF).toBe(postPull);
      expect(cache.TASK_BASE_REF_TRUSTED).toBe("1");
      expect(cache.TASK_BASE_REF).not.toBe(
        "1111111111111111111111111111111111111111",
      );
      // Task work + complete: the snapshot must contain only clone A's file.
      writeFileSync(join(cloneA, "task.txt"), "task work\n");
      putCalls = [];
      await hooks["tool.execute.before"]({
        input: { command: COMPLETE_CMD },
      });
      const snap: { path: string }[] = JSON.parse(
        readFileSync(join(cloneA, ".stride-changed-files.json"), "utf8"),
      );
      const paths = snap.map((e) => e.path);
      expect(paths).toContain("task.txt");
      expect(paths).not.toContain("w1678.txt");
    } finally {
      cleanup(root);
    }
  });

  it("D142: a push-in-after_doing keeps the task's file (base resolved once, pre-push) and persists it for the self-heal", async () => {
    const root = mkdtempSync(join(tmpdir(), "stride-oc-d142-push-"));
    try {
      const origin = join(root, "origin.git");
      await $`git init -q --bare ${origin}`.quiet();
      await $`git -C ${origin} symbolic-ref HEAD refs/heads/main`.quiet();
      const work = join(root, "work");
      await $`git clone -q ${origin} ${work}`.quiet();
      await $`git -C ${work} config user.email test@test.local`.quiet();
      await $`git -C ${work} config user.name Test`.quiet();
      await $`git -C ${work} config commit.gpgsign false`.quiet();
      await $`git -C ${work} checkout -q -b main`.nothrow().quiet();
      writeFileSync(
        join(work, ".gitignore"),
        ".stride.md\n.stride-changed-files.json\n.stride-diff-upload-state\n.stride-env-cache\n",
      );
      writeFileSync(join(work, "tracked.txt"), "v1\n");
      await $`git -C ${work} add .gitignore tracked.txt`.quiet();
      await $`git -C ${work} commit -q -m v1`.quiet();
      await $`git -C ${work} push -q origin main`.quiet();
      const base = (await $`git -C ${work} rev-parse HEAD`.quiet())
        .stdout.toString()
        .trim();
      // Task work committed locally but not yet pushed.
      writeFileSync(join(work, "tracked.txt"), "v2\n");
      await $`git -C ${work} add tracked.txt`.quiet();
      await $`git -C ${work} commit -q -m "task work"`.quiet();
      // after_doing pushes the default branch, advancing origin/main to HEAD.
      writeFileSync(
        join(work, ".stride.md"),
        "## after_doing\n\n```bash\ngit push -q origin main\n```\n",
      );
      // Untrusted inherited base (no TASK_BASE_REF_TRUSTED) to exercise the guard.
      writeFileSync(
        join(work, ".stride-env-cache"),
        `{"TASK_ID":"55","TASK_BASE_REF":"${base}"}\n`,
      );
      const hooks = await instantiate(work);
      putCalls = [];
      await hooks["tool.execute.before"]({
        input: { command: COMPLETE_CMD },
      });
      const snap: { path: string }[] = JSON.parse(
        readFileSync(join(work, ".stride-changed-files.json"), "utf8"),
      );
      const paths = snap.map((e) => e.path);
      // Without the once-per-window memoization the post-push refresh would
      // re-resolve against the moved origin/main, recompute the base to HEAD,
      // and empty the snapshot.
      expect(paths).toContain("tracked.txt");
      const state = readFileSync(
        join(work, ".stride-diff-upload-state"),
        "utf8",
      );
      expect(state).toContain(`base=${base}`);
    } finally {
      cleanup(root);
    }
  });
});

// --- StridePlugin D65: passing-gate output off stderr, folded into commands_output ---
//
// These tests use `pwd` (succeeds, emits output) and `false` (exits 1) and
// skip the claim step so envCache stays empty. Multi-token and shell-syntax
// coverage lives in the D95 describe below — since D95, executeCommands runs
// each line through `sh -c`, so any shell command works here.

describe("StridePlugin — D65 passing-gate output → commands_output (off stderr)", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async () => new Response("", { status: 200 });
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  async function initRepo(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "stride-oc-d65-"));
    await $`git init -q`.cwd(dir).quiet();
    await $`git config user.email "test@test.local"`.cwd(dir).quiet();
    await $`git config user.name "Test"`.cwd(dir).quiet();
    writeFileSync(join(dir, "tracked.txt"), "v1\n");
    await $`git add -A`.cwd(dir).quiet();
    await $`git commit -q -m v1`.cwd(dir).quiet();
    return dir;
  }
  function cleanup(dir: string): void {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  async function instantiate(dir: string) {
    return (await StridePlugin({ directory: dir, worktree: dir, $ } as never)) as {
      "tool.execute.before": (i: unknown, o?: unknown) => Promise<void>;
      "tool.execute.after": (i: unknown, o?: unknown) => Promise<void>;
    };
  }

  it("D65: a passing after_doing gate writes its output nowhere on process.stderr", async () => {
    const dir = await initRepo();
    const origWrite = process.stderr.write.bind(process.stderr);
    let captured = "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = (chunk: unknown) => {
      captured += String(chunk);
      return true;
    };
    try {
      // No claim ⇒ empty envCache ⇒ the single-token gate command runs and
      // succeeds. `pwd` emits the repo dir on stdout — which must NOT leak to
      // stderr now that D65 folds it into commands_output instead.
      const hooks = await instantiate(dir);
      writeFileSync(join(dir, ".stride.md"), "## after_doing\n\n```bash\npwd\n```\n");
      await hooks["tool.execute.before"]({
        input: { command: 'curl -X PATCH http://localhost/api/tasks/42/complete -H "Authorization: Bearer tok"' },
      });
      expect(captured).not.toContain(dir);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stderr as any).write = origWrite;
      cleanup(dir);
    }
  });

  it("D65: passing-command output is folded into commands_output on the success JSON", async () => {
    const dir = await initRepo();
    const origOut = process.stdout.write.bind(process.stdout);
    let stdoutCap = "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = (chunk: unknown) => {
      stdoutCap += String(chunk);
      return true;
    };
    try {
      // The after_goal path is the only place a success HookResult is serialized
      // to stdout, so it's where commands_output is observable. Empty envCache ⇒
      // the single-token `pwd` after_goal command succeeds and emits output.
      const hooks = await instantiate(dir);
      writeFileSync(join(dir, ".stride.md"), "## after_goal\n\n```bash\npwd\n```\n");
      const response = JSON.stringify({ hooks: [{ name: "after_goal" }] });
      await hooks["tool.execute.after"](
        { input: { command: "curl -X PATCH http://localhost/api/tasks/42/complete" } },
        response,
      );
      const line = stdoutCap.split("\n").find((l) => l.includes('"hook":"after_goal"'));
      expect(line).toBeDefined();
      const parsed = JSON.parse(line as string);
      expect(parsed.status).toBe("success");
      expect(Array.isArray(parsed.commands_output)).toBe(true);
      expect(parsed.commands_output[0].command).toBe("pwd");
      expect(parsed.commands_output[0].stdout).toContain(dir);
      expect(parsed.commands_output[0].stderr).toBe("");
      // No top-level stderr field on the success shape.
      expect(parsed.stderr).toBeUndefined();
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stdout as any).write = origOut;
      cleanup(dir);
    }
  });

  it("D65: the failure path is unchanged (failed JSON keeps stdout/stderr, no commands_output)", async () => {
    const dir = await initRepo();
    const origOut = process.stdout.write.bind(process.stdout);
    let stdoutCap = "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = (chunk: unknown) => { stdoutCap += String(chunk); return true; };
    try {
      // `false` is a single token that exits 1 ⇒ the failure branch is taken.
      const hooks = await instantiate(dir);
      writeFileSync(join(dir, ".stride.md"), "## after_goal\n\n```bash\nfalse\n```\n");
      const response = JSON.stringify({ hooks: [{ name: "after_goal" }] });
      await hooks["tool.execute.after"](
        { input: { command: "curl -X PATCH http://localhost/api/tasks/42/complete" } },
        response,
      );
      const line = stdoutCap.split("\n").find((l) => l.includes('"hook":"after_goal"'));
      expect(line).toBeDefined();
      const parsed = JSON.parse(line as string);
      expect(parsed.status).toBe("failed");
      expect(parsed.exit_code).toBe(1);
      expect("commands_output" in parsed).toBe(false);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stdout as any).write = origOut;
      cleanup(dir);
    }
  });
});

// --- StridePlugin D95: hook commands run through `sh -c` ---
//
// executeCommands passes each .stride.md line to `sh -c` as a single escaped
// argument, so shell parsing (multi-token commands, &&, pipes, redirects,
// quotes) happens in a real shell, with cwd set to the project dir and the
// env cache delivered through the child environment (never shell text).
// The after_goal path is used for observation because it is the only place a
// HookResult is serialized to stdout.

describe("StridePlugin — D95 sh -c command execution", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async () => new Response("", { status: 200 });
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  async function initRepo(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "stride-oc-d95-"));
    await $`git init -q`.cwd(dir).quiet();
    await $`git config user.email "test@test.local"`.cwd(dir).quiet();
    await $`git config user.name "Test"`.cwd(dir).quiet();
    writeFileSync(join(dir, "tracked.txt"), "v1\n");
    await $`git add -A`.cwd(dir).quiet();
    await $`git commit -q -m v1`.cwd(dir).quiet();
    return dir;
  }
  function cleanup(dir: string): void {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  async function instantiate(dir: string) {
    return (await StridePlugin({ directory: dir, worktree: dir, $ } as never)) as {
      "tool.execute.before": (i: unknown, o?: unknown) => Promise<void>;
      "tool.execute.after": (i: unknown, o?: unknown) => Promise<void>;
    };
  }

  const COMPLETE_CMD =
    'curl -X PATCH http://localhost/api/tasks/42/complete -H "Authorization: Bearer tok"';
  const AFTER_GOAL_RESPONSE = JSON.stringify({ hooks: [{ name: "after_goal" }] });

  // Run the given after_goal section and return the parsed HookResult JSON
  // emitted on stdout.
  async function runAfterGoal(
    dir: string,
    hooks: Awaited<ReturnType<typeof instantiate>>,
    section: string,
  ): Promise<Record<string, any>> {
    writeFileSync(join(dir, ".stride.md"), `## after_goal\n\n\`\`\`bash\n${section}\n\`\`\`\n`);
    const origOut = process.stdout.write.bind(process.stdout);
    let stdoutCap = "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = (chunk: unknown) => { stdoutCap += String(chunk); return true; };
    try {
      await hooks["tool.execute.after"]({ input: { command: COMPLETE_CMD } }, AFTER_GOAL_RESPONSE);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stdout as any).write = origOut;
    }
    const line = stdoutCap.split("\n").find((l) => l.includes('"hook":"after_goal"'));
    expect(line).toBeDefined();
    return JSON.parse(line as string);
  }

  it("D95: a multi-token command (git status --short) runs and captures stdout, with empty envCache", async () => {
    const dir = await initRepo();
    try {
      const hooks = await instantiate(dir);
      // No claim step ⇒ envCache stays empty. cwd must be the repo dir for
      // git to see the untracked file.
      writeFileSync(join(dir, "newfile.txt"), "hello\n");
      const parsed = await runAfterGoal(dir, hooks, "git status --short");
      expect(parsed.status).toBe("success");
      expect(parsed.commands_output[0].stdout).toContain("?? newfile.txt");
    } finally {
      cleanup(dir);
    }
  });

  it("D95: && inside a line runs both commands", async () => {
    const dir = await initRepo();
    try {
      const hooks = await instantiate(dir);
      const parsed = await runAfterGoal(dir, hooks, "echo one && echo two");
      expect(parsed.status).toBe("success");
      expect(parsed.commands_output[0].stdout).toBe("one\ntwo\n");
    } finally {
      cleanup(dir);
    }
  });

  it("D95: && inside a line stops at the first failure", async () => {
    const dir = await initRepo();
    try {
      const hooks = await instantiate(dir);
      const parsed = await runAfterGoal(dir, hooks, "false && echo never");
      expect(parsed.status).toBe("failed");
      expect(parsed.exit_code).toBe(1);
      expect(parsed.stdout).not.toContain("never");
    } finally {
      cleanup(dir);
    }
  });

  it("D95: pipes and output redirects work, with the redirect landing in the project dir", async () => {
    const dir = await initRepo();
    try {
      const hooks = await instantiate(dir);
      const parsed = await runAfterGoal(
        dir,
        hooks,
        "printf 'a\\nb\\nc\\n' | wc -l\necho hi > out.txt",
      );
      expect(parsed.status).toBe("success");
      expect(parsed.commands_output[0].stdout.trim()).toBe("3");
      expect(readFileSync(join(dir, "out.txt"), "utf8")).toBe("hi\n");
    } finally {
      cleanup(dir);
    }
  });

  it("D95: env-cache values reach commands as env vars, delivered literally (no expansion, no injection)", async () => {
    const dir = await initRepo();
    try {
      const hooks = await instantiate(dir);
      // Task titles are user-controlled: this one carries $-refs, backticks,
      // and both quote styles. It must arrive byte-for-byte in the child env —
      // never evaluated as shell text.
      const title = "Pay $100 via `whoami` \"double\" 'single'";
      const claimResponse = JSON.stringify({
        data: { id: 42, identifier: "W42", title, status: "in_progress" },
      });
      await hooks["tool.execute.after"](
        { input: { command: "curl -X POST http://localhost/api/tasks/claim" } },
        claimResponse,
      );
      const parsed = await runAfterGoal(dir, hooks, 'echo "title=$TASK_TITLE"');
      expect(parsed.status).toBe("success");
      expect(parsed.commands_output[0].stdout).toBe(`title=${title}\n`);
    } finally {
      cleanup(dir);
    }
  });

  it("D95: embedded single and double quotes parse as shell quoting", async () => {
    const dir = await initRepo();
    try {
      const hooks = await instantiate(dir);
      const parsed = await runAfterGoal(dir, hooks, "echo \"double part\" 'single part'");
      expect(parsed.status).toBe("success");
      expect(parsed.commands_output[0].stdout).toBe("double part single part\n");
    } finally {
      cleanup(dir);
    }
  });

  it("D95: a command that emits only stderr still succeeds with stderr captured", async () => {
    const dir = await initRepo();
    try {
      const hooks = await instantiate(dir);
      const parsed = await runAfterGoal(dir, hooks, "echo warn >&2");
      expect(parsed.status).toBe("success");
      expect(parsed.commands_output[0].stdout).toBe("");
      expect(parsed.commands_output[0].stderr).toBe("warn\n");
    } finally {
      cleanup(dir);
    }
  });

  it("D95: a failing multi-token command returns the structured failure shape with commands_remaining", async () => {
    const dir = await initRepo();
    try {
      const hooks = await instantiate(dir);
      const parsed = await runAfterGoal(
        dir,
        hooks,
        "git status --bogus-flag-nope\necho second",
      );
      expect(parsed.status).toBe("failed");
      expect(parsed.failed_command).toBe("git status --bogus-flag-nope");
      expect(parsed.command_index).toBe(0);
      expect(parsed.exit_code).not.toBe(0);
      expect(parsed.stderr).not.toBe("");
      expect(parsed.commands_completed).toEqual([]);
      expect(parsed.commands_remaining).toEqual(["echo second"]);
    } finally {
      cleanup(dir);
    }
  });

  it("D95: full tool.execute.before after_doing flow passes with a multi-token gate command", async () => {
    const dir = await initRepo();
    try {
      const hooks = await instantiate(dir);
      writeFileSync(
        join(dir, ".stride.md"),
        "## after_doing\n\n```bash\ngit status --short\n```\n",
      );
      // Before D95 this threw command-not-found (the whole line was escaped
      // into a single token). Now the gate passes.
      await hooks["tool.execute.before"]({ input: { command: COMPLETE_CMD } });
      expect(existsSync(join(dir, ".stride-changed-files.json"))).toBe(true);
    } finally {
      cleanup(dir);
    }
  });
});

// --- StridePlugin W1495: per-hook timeout enforcement ---
//
// The plugin factory accepts test-only hookTimeoutsMs/killGraceMs overrides
// (via the same `as never` cast the other describes use) so hanging gate
// commands time out in milliseconds instead of the canonical 60s/120s.

describe("StridePlugin — W1495 per-hook timeout enforcement", () => {
  const originalFetch = globalThis.fetch;
  let putCalls: string[] = [];
  beforeEach(() => {
    putCalls = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async (url: string) => {
      if (typeof url === "string" && url.includes("/changed_files")) {
        putCalls.push(url);
      }
      return new Response("", { status: 200 });
    };
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  async function initRepo(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "stride-oc-w1495-"));
    await $`git init -q`.cwd(dir).quiet();
    await $`git config user.email "test@test.local"`.cwd(dir).quiet();
    await $`git config user.name "Test"`.cwd(dir).quiet();
    writeFileSync(join(dir, "tracked.txt"), "v1\n");
    await $`git add -A`.cwd(dir).quiet();
    await $`git commit -q -m v1`.cwd(dir).quiet();
    return dir;
  }
  function cleanup(dir: string): void {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  async function instantiate(
    dir: string,
    hookTimeoutsMs: Record<string, number>,
  ) {
    return (await StridePlugin({
      directory: dir,
      worktree: dir,
      $,
      hookTimeoutsMs,
      killGraceMs: 100,
    } as never)) as {
      "tool.execute.before": (i: unknown, o?: unknown) => Promise<void>;
      "tool.execute.after": (i: unknown, o?: unknown) => Promise<void>;
    };
  }

  const CLAIM_CMD = "curl -X POST http://localhost/api/tasks/claim";
  const COMPLETE_CMD =
    'curl -X PATCH http://localhost/api/tasks/42/complete -H "Authorization: Bearer tok"';
  const CLAIM_RESPONSE = JSON.stringify({
    data: { id: 42, identifier: "W42", title: "T", status: "in_progress" },
  });

  it("W1495: a hanging after_doing gate throws the structured timeout failure and keeps the early diff capture", async () => {
    const dir = await initRepo();
    try {
      const hooks = await instantiate(dir, { after_doing: 150 });
      await hooks["tool.execute.after"]({ input: { command: CLAIM_CMD } }, CLAIM_RESPONSE);
      putCalls = [];
      writeFileSync(join(dir, ".stride.md"), "## after_doing\n\n```bash\nsleep 5\n```\n");
      let message = "";
      try {
        await hooks["tool.execute.before"]({ input: { command: COMPLETE_CMD } });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).not.toBe("");
      const parsed = JSON.parse(message);
      expect(parsed.hook).toBe("after_doing");
      expect(parsed.status).toBe("failed");
      expect(parsed.timed_out).toBe(true);
      expect(parsed.exit_code).toBe(124);
      expect(parsed.failed_command).toBe("sleep 5");
      expect(parsed.command_index).toBe(0);
      expect(parsed.budget_ms).toBe(150);
      // (W1093) The early diff capture ran BEFORE the gate hung — a timed-out
      // gate must not lose the changed-files upload.
      expect(existsSync(join(dir, ".stride-changed-files.json"))).toBe(true);
      expect(putCalls.length).toBe(1);
    } finally {
      cleanup(dir);
    }
  });

  it("W1495: an after_goal timeout serializes timed_out and budget_ms in the failure JSON", async () => {
    const dir = await initRepo();
    try {
      const hooks = await instantiate(dir, { after_goal: 150 });
      writeFileSync(join(dir, ".stride.md"), "## after_goal\n\n```bash\nsleep 5\n```\n");
      const origOut = process.stdout.write.bind(process.stdout);
      let stdoutCap = "";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stdout as any).write = (chunk: unknown) => { stdoutCap += String(chunk); return true; };
      try {
        await hooks["tool.execute.after"](
          { input: { command: COMPLETE_CMD } },
          JSON.stringify({ hooks: [{ name: "after_goal" }] }),
        );
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (process.stdout as any).write = origOut;
      }
      const line = stdoutCap.split("\n").find((l) => l.includes('"hook":"after_goal"'));
      expect(line).toBeDefined();
      const parsed = JSON.parse(line as string);
      expect(parsed.status).toBe("failed");
      expect(parsed.timed_out).toBe(true);
      expect(parsed.budget_ms).toBe(150);
      expect(parsed.exit_code).toBe(124);
    } finally {
      cleanup(dir);
    }
  });

  it("W1495: a before_review timeout writes the timed-out stderr phrasing", async () => {
    const dir = await initRepo();
    try {
      const hooks = await instantiate(dir, { before_review: 100 });
      writeFileSync(join(dir, ".stride.md"), "## before_review\n\n```bash\nsleep 5\n```\n");
      const origErr = process.stderr.write.bind(process.stderr);
      let stderrCap = "";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stderr as any).write = (chunk: unknown) => { stderrCap += String(chunk); return true; };
      try {
        await hooks["tool.execute.after"]({ input: { command: COMPLETE_CMD } }, "");
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (process.stderr as any).write = origErr;
      }
      expect(stderrCap).toMatch(/timed out after 1s budget: sleep 5/);
    } finally {
      cleanup(dir);
    }
  });
});

// --- StridePlugin W1496: env cache persisted to disk across restarts ---
//
// The claim writes envCache to .stride-env-cache; a fresh plugin instance
// (same dir) simulates a host restart — its empty in-memory cache is lazily
// rehydrated from the file, so the after_doing capture, self-heal, and hook
// env delivery all keep working with the original TASK_ID/TASK_BASE_REF.

describe("StridePlugin — W1496 env-cache persistence across restart", () => {
  const originalFetch = globalThis.fetch;
  let putCalls: string[] = [];

  beforeEach(() => {
    putCalls = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async (url: string) => {
      if (typeof url === "string" && url.includes("/changed_files")) {
        putCalls.push(url);
      }
      return new Response("", { status: 200 });
    };
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  async function initRepo(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "stride-oc-w1496-"));
    await $`git init -q`.cwd(dir).quiet();
    await $`git config user.email "test@test.local"`.cwd(dir).quiet();
    await $`git config user.name "Test"`.cwd(dir).quiet();
    writeFileSync(
      join(dir, ".gitignore"),
      ".stride.md\n.stride-changed-files.json\n.stride-diff-upload-state\n.stride-env-cache\n",
    );
    writeFileSync(join(dir, "tracked.txt"), "v1\n");
    await $`git add .gitignore tracked.txt`.cwd(dir).quiet();
    await $`git commit -q -m v1`.cwd(dir).quiet();
    return dir;
  }
  function cleanup(dir: string): void {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  async function instantiate(dir: string) {
    return (await StridePlugin({ directory: dir, worktree: dir, $ } as never)) as {
      "tool.execute.before": (i: unknown, o?: unknown) => Promise<void>;
      "tool.execute.after": (i: unknown, o?: unknown) => Promise<void>;
    };
  }

  const CLAIM_CMD =
    'curl -X POST http://localhost/api/tasks/claim -H "Authorization: Bearer tok"';
  const COMPLETE_CMD =
    'curl -X PATCH http://localhost/api/tasks/42/complete -H "Authorization: Bearer tok"';
  const CLAIM_RESPONSE = JSON.stringify({
    data: { id: 42, identifier: "W42", title: "T", status: "in_progress" },
  });

  it("W1496: claim writes the extracted env cache to .stride-env-cache — task metadata only", async () => {
    const dir = await initRepo();
    try {
      const hooks = await instantiate(dir);
      await hooks["tool.execute.after"]({ input: { command: CLAIM_CMD } }, CLAIM_RESPONSE);
      const raw = readFileSync(join(dir, ".stride-env-cache"), "utf8");
      const cache = JSON.parse(raw);
      expect(cache.TASK_ID).toBe("42");
      expect(cache.TASK_IDENTIFIER).toBe("W42");
      expect(cache.TASK_BASE_REF).toMatch(/^[0-9a-f]{40}$/);
      // The claim command carried a bearer token — it must not reach the file.
      expect(raw).not.toMatch(/Bearer|tok/);
    } finally {
      cleanup(dir);
    }
  });

  it("W1496: a fresh instance reloads the cache — after_doing PUTs with the original TASK_ID and TASK_BASE_REF", async () => {
    const dir = await initRepo();
    try {
      const instanceA = await instantiate(dir);
      await instanceA["tool.execute.after"]({ input: { command: CLAIM_CMD } }, CLAIM_RESPONSE);
      // Two post-claim commits: a HEAD~1 fallback would only see b.txt, so
      // a.txt appearing in the snapshot proves TASK_BASE_REF was reloaded.
      writeFileSync(join(dir, "a.txt"), "post-claim a\n");
      await $`git add a.txt`.cwd(dir).quiet();
      await $`git commit -q -m a`.cwd(dir).quiet();
      writeFileSync(join(dir, "b.txt"), "post-claim b\n");
      await $`git add b.txt`.cwd(dir).quiet();
      await $`git commit -q -m b`.cwd(dir).quiet();

      putCalls = [];
      const instanceB = await instantiate(dir); // restart: empty in-memory cache
      writeFileSync(join(dir, ".stride.md"), "## after_doing\n\n```bash\n```\n");
      await instanceB["tool.execute.before"]({ input: { command: COMPLETE_CMD } });

      expect(putCalls.length).toBe(1);
      expect(putCalls[0]).toContain("/api/tasks/42/changed_files");
      const state = readFileSync(join(dir, ".stride-diff-upload-state"), "utf8");
      expect(state).toMatch(/^task_id=42\nhttp_code=200\nbase=[0-9a-f]{40}\n$/);
      const snapshot = JSON.parse(
        readFileSync(join(dir, ".stride-changed-files.json"), "utf8"),
      ) as { path: string }[];
      const paths = snapshot.map((f) => f.path);
      expect(paths).toContain("a.txt");
      expect(paths).toContain("b.txt");
    } finally {
      cleanup(dir);
    }
  });

  it("W1496: a fresh instance's before_review self-heal still finds TASK_ID", async () => {
    const dir = await initRepo();
    try {
      const instanceA = await instantiate(dir);
      await instanceA["tool.execute.after"]({ input: { command: CLAIM_CMD } }, CLAIM_RESPONSE);
      putCalls = [];
      const instanceB = await instantiate(dir);
      await instanceB["tool.execute.after"]({ input: { command: COMPLETE_CMD } }, "");
      expect(putCalls.length).toBe(1);
      expect(putCalls[0]).toContain("/api/tasks/42/changed_files");
    } finally {
      cleanup(dir);
    }
  });

  it("W1496: after_review clears the cache file alongside the other state files", async () => {
    const dir = await initRepo();
    try {
      const hooks = await instantiate(dir);
      await hooks["tool.execute.after"]({ input: { command: CLAIM_CMD } }, CLAIM_RESPONSE);
      expect(existsSync(join(dir, ".stride-env-cache"))).toBe(true);
      writeFileSync(join(dir, ".stride.md"), "## before_doing\n\n```bash\necho hi\n```\n");
      const reviewCmd = "curl -X PATCH http://localhost/api/tasks/42/mark_reviewed";
      await hooks["tool.execute.after"]({ input: { command: reviewCmd } }, "");
      expect(existsSync(join(dir, ".stride-env-cache"))).toBe(false);
      expect(existsSync(join(dir, ".stride-changed-files.json"))).toBe(false);
      expect(existsSync(join(dir, ".stride-diff-upload-state"))).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  it("W1496: a new claim overwrites a stale prior-task cache", async () => {
    const dir = await initRepo();
    try {
      writeFileSync(
        join(dir, ".stride-env-cache"),
        '{"TASK_ID":"41","TASK_DESCRIPTION":"old"}\n',
      );
      const hooks = await instantiate(dir);
      await hooks["tool.execute.after"]({ input: { command: CLAIM_CMD } }, CLAIM_RESPONSE);
      const cache = JSON.parse(readFileSync(join(dir, ".stride-env-cache"), "utf8"));
      expect(cache.TASK_ID).toBe("42");
      expect("TASK_DESCRIPTION" in cache).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  it("W1496/D127: a corrupt cache no longer loses the PUT — it targets the /complete URL id", async () => {
    const dir = await initRepo();
    try {
      writeFileSync(join(dir, ".stride-env-cache"), "{corrupt");
      const hooks = await instantiate(dir);
      writeFileSync(join(dir, ".stride.md"), "## after_doing\n\n```bash\n```\n");
      await hooks["tool.execute.before"]({ input: { command: COMPLETE_CMD } });
      // No env TASK_ID, but the /complete URL carries the authoritative id 42
      // (D127) → the PUT and upload-state record now target it instead of being
      // skipped. The snapshot is still written as before.
      expect(putCalls.length).toBe(1);
      expect(putCalls[0]).toContain("/api/tasks/42/changed_files");
      const state = readFileSync(join(dir, ".stride-diff-upload-state"), "utf8");
      // No claim ran and the cache is corrupt → no TASK_BASE_REF, so the D142
      // base line is absent (resolveSnapshotBase passed through undefined).
      expect(state).toBe("task_id=42\nhttp_code=200\n");
      expect(existsSync(join(dir, ".stride-changed-files.json"))).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  it("W1496: deleting the cache file mid-task doesn't hurt the same instance (memory wins)", async () => {
    const dir = await initRepo();
    try {
      const hooks = await instantiate(dir);
      await hooks["tool.execute.after"]({ input: { command: CLAIM_CMD } }, CLAIM_RESPONSE);
      rmSync(join(dir, ".stride-env-cache"));
      putCalls = [];
      writeFileSync(join(dir, ".stride.md"), "## after_doing\n\n```bash\n```\n");
      await hooks["tool.execute.before"]({ input: { command: COMPLETE_CMD } });
      expect(putCalls.length).toBe(1);
      expect(putCalls[0]).toContain("/api/tasks/42/changed_files");
    } finally {
      cleanup(dir);
    }
  });

  it("W1496: two projects keep separate caches", async () => {
    const dirA = await initRepo();
    const dirB = await initRepo();
    try {
      const hooksA = await instantiate(dirA);
      const hooksB = await instantiate(dirB);
      await hooksA["tool.execute.after"]({ input: { command: CLAIM_CMD } }, CLAIM_RESPONSE);
      const claimB = JSON.stringify({
        data: { id: 43, identifier: "W43", title: "U", status: "in_progress" },
      });
      await hooksB["tool.execute.after"]({ input: { command: CLAIM_CMD } }, claimB);
      const cacheA = JSON.parse(readFileSync(join(dirA, ".stride-env-cache"), "utf8"));
      const cacheB = JSON.parse(readFileSync(join(dirB, ".stride-env-cache"), "utf8"));
      expect(cacheA.TASK_ID).toBe("42");
      expect(cacheB.TASK_ID).toBe("43");
    } finally {
      cleanup(dirA);
      cleanup(dirB);
    }
  });

  it("W1496: hook commands on a fresh instance still see the persisted env vars, byte-for-byte", async () => {
    const dir = await initRepo();
    try {
      const title = "Pay $100 via `whoami` \"double\" 'single'";
      const claimResponse = JSON.stringify({
        data: { id: 42, identifier: "W42", title, status: "in_progress" },
      });
      const instanceA = await instantiate(dir);
      await instanceA["tool.execute.after"]({ input: { command: CLAIM_CMD } }, claimResponse);

      const instanceB = await instantiate(dir); // restart
      writeFileSync(
        join(dir, ".stride.md"),
        '## after_goal\n\n```bash\necho "title=$TASK_TITLE"\n```\n',
      );
      const origOut = process.stdout.write.bind(process.stdout);
      let stdoutCap = "";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stdout as any).write = (chunk: unknown) => { stdoutCap += String(chunk); return true; };
      try {
        await instanceB["tool.execute.after"](
          { input: { command: COMPLETE_CMD } },
          JSON.stringify({ hooks: [{ name: "after_goal" }] }),
        );
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (process.stdout as any).write = origOut;
      }
      const line = stdoutCap.split("\n").find((l) => l.includes('"hook":"after_goal"'));
      expect(line).toBeDefined();
      const parsed = JSON.parse(line as string);
      expect(parsed.status).toBe("success");
      expect(parsed.commands_output[0].stdout).toBe(`title=${title}\n`);
    } finally {
      cleanup(dir);
    }
  });
});

// --- W1497: server-supplied hook env forwarded to hook commands ---
//
// extractHookEnvFromResponse mirrors stride-hook.sh's extract_hook_env: the
// claim response carries a SINGULAR `hook` object, complete/mark_reviewed a
// `hooks` ARRAY; the entry matching the routed hook supplies its env, which
// is delivered ephemerally to that hook's commands (server wins on
// collision), with GOAL_* isolated to after_goal.

describe("extractHookEnvFromResponse", () => {
  it("reads the singular claim `hook` entry and returns all its keys including HOOK_NAME", () => {
    const response = JSON.stringify({
      data: { id: 42 },
      hook: {
        name: "before_doing",
        env: {
          HOOK_NAME: "before_doing",
          AGENT_NAME: "oc",
          BOARD_ID: "7",
          BOARD_NAME: "Main",
          COLUMN_ID: "3",
          COLUMN_NAME: "Doing",
        },
      },
    });
    expect(extractHookEnvFromResponse(response, "before_doing")).toEqual({
      HOOK_NAME: "before_doing",
      AGENT_NAME: "oc",
      BOARD_ID: "7",
      BOARD_NAME: "Main",
      COLUMN_ID: "3",
      COLUMN_NAME: "Doing",
    });
  });

  it("routes each hooks-array entry env only to its own hook name", () => {
    const response = JSON.stringify({
      data: { id: 42 },
      hooks: [
        { name: "before_review", env: { BOARD_ID: "7" } },
        { name: "after_goal", env: { GOAL_ID: "9", GOAL_IDENTIFIER: "G9" } },
      ],
    });
    expect(extractHookEnvFromResponse(response, "after_goal")).toEqual({
      GOAL_ID: "9",
      GOAL_IDENTIFIER: "G9",
    });
    const beforeReview = extractHookEnvFromResponse(response, "before_review");
    expect(beforeReview).toEqual({ BOARD_ID: "7" });
    expect("GOAL_ID" in beforeReview).toBe(false);
  });

  it("peels the Bash-tool stdout wrapper", () => {
    const inner = JSON.stringify({
      hooks: [{ name: "after_goal", env: { GOAL_ID: "9" } }],
    });
    const wrapped = JSON.stringify({ stdout: inner, stderr: "" });
    expect(extractHookEnvFromResponse(wrapped, "after_goal")).toEqual({
      GOAL_ID: "9",
    });
  });

  it("returns {} when there is no hooks key, an empty array, or no matching entry", () => {
    expect(
      extractHookEnvFromResponse(JSON.stringify({ data: { id: 42 } }), "before_doing"),
    ).toEqual({});
    expect(
      extractHookEnvFromResponse(JSON.stringify({ hooks: [] }), "before_doing"),
    ).toEqual({});
    expect(
      extractHookEnvFromResponse(
        JSON.stringify({ hooks: [{ name: "after_goal" }] }),
        "before_review",
      ),
    ).toEqual({});
  });

  it("returns {} for a matching entry with an empty or missing env", () => {
    expect(
      extractHookEnvFromResponse(
        JSON.stringify({ hooks: [{ name: "after_goal", env: {} }] }),
        "after_goal",
      ),
    ).toEqual({});
    expect(
      extractHookEnvFromResponse(
        JSON.stringify({ hooks: [{ name: "after_goal" }] }),
        "after_goal",
      ),
    ).toEqual({});
  });

  it("drops TASK_BASE_REF — the client-owned diff anchor is never server-overridden", () => {
    const response = JSON.stringify({
      hook: {
        name: "before_doing",
        env: { TASK_BASE_REF: "bogus", BOARD_ID: "7" },
      },
    });
    expect(extractHookEnvFromResponse(response, "before_doing")).toEqual({
      BOARD_ID: "7",
    });
  });

  it("drops non-identifier keys and non-scalar values; coerces numbers and booleans", () => {
    const response = JSON.stringify({
      hook: {
        name: "before_doing",
        env: {
          "BAD-KEY": "x",
          "1X": "y",
          BOARD_ID: 7,
          TASK_NEEDS_REVIEW: false,
          NESTED: { a: 1 },
          NOTHING: null,
          LIST: ["a"],
        },
      },
    });
    expect(extractHookEnvFromResponse(response, "before_doing")).toEqual({
      BOARD_ID: "7",
      TASK_NEEDS_REVIEW: "false",
    });
  });

  it("returns {} for non-JSON or empty input", () => {
    expect(extractHookEnvFromResponse("not json", "before_doing")).toEqual({});
    expect(extractHookEnvFromResponse("", "before_doing")).toEqual({});
  });

  it("unions the hooks array with a singular hook entry", () => {
    const response = JSON.stringify({
      hooks: [{ name: "after_goal", env: { GOAL_ID: "9" } }],
      hook: { name: "before_doing", env: { BOARD_ID: "7" } },
    });
    expect(extractHookEnvFromResponse(response, "before_doing")).toEqual({
      BOARD_ID: "7",
    });
    expect(extractHookEnvFromResponse(response, "after_goal")).toEqual({
      GOAL_ID: "9",
    });
  });
});

describe("coerceOutputText / peelPayloadRoot", () => {
  it("coerces strings, .output/.result wrappers, raw objects, and null", () => {
    expect(coerceOutputText("abc")).toBe("abc");
    expect(coerceOutputText({ output: "xyz" })).toBe("xyz");
    expect(coerceOutputText({ result: "res" })).toBe("res");
    expect(coerceOutputText({ hooks: [] })).toBe(JSON.stringify({ hooks: [] }));
    expect(coerceOutputText(null)).toBe("");
    expect(coerceOutputText(undefined)).toBe("");
  });

  it("treats an empty-string .output as absent so a populated .result wins", () => {
    expect(coerceOutputText({ output: "", result: "res" })).toBe("res");
    expect(coerceOutputText({ output: "", result: undefined })).toBe("");
  });

  it("peels to the payload root through the stdout wrapper and rejects non-objects", () => {
    const inner = JSON.stringify({ hooks: [{ name: "after_goal" }] });
    expect(peelPayloadRoot(JSON.stringify({ stdout: inner }))).toEqual({
      hooks: [{ name: "after_goal" }],
    });
    expect(peelPayloadRoot(inner)).toEqual({ hooks: [{ name: "after_goal" }] });
    expect(peelPayloadRoot("not json")).toBeNull();
    expect(peelPayloadRoot('"a string"')).toBeNull();
    expect(peelPayloadRoot("[1,2]")).toBeNull();
  });
});

// --- StridePlugin W1497: integration — server hook env reaches commands ---

describe("StridePlugin — W1497 server hook env forwarding", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async () => new Response("", { status: 200 });
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  async function initRepo(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "stride-oc-w1497-"));
    await $`git init -q`.cwd(dir).quiet();
    await $`git config user.email "test@test.local"`.cwd(dir).quiet();
    await $`git config user.name "Test"`.cwd(dir).quiet();
    writeFileSync(
      join(dir, ".gitignore"),
      ".stride.md\n.stride-changed-files.json\n.stride-diff-upload-state\n.stride-env-cache\nboard.txt\ngoalcheck.txt\n",
    );
    writeFileSync(join(dir, "tracked.txt"), "v1\n");
    await $`git add .gitignore tracked.txt`.cwd(dir).quiet();
    await $`git commit -q -m v1`.cwd(dir).quiet();
    return dir;
  }
  function cleanup(dir: string): void {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  async function instantiate(dir: string) {
    return (await StridePlugin({ directory: dir, worktree: dir, $ } as never)) as {
      "tool.execute.before": (i: unknown, o?: unknown) => Promise<void>;
      "tool.execute.after": (i: unknown, o?: unknown) => Promise<void>;
    };
  }

  const CLAIM_CMD = "curl -X POST http://localhost/api/tasks/claim";
  const COMPLETE_CMD =
    'curl -X PATCH http://localhost/api/tasks/42/complete -H "Authorization: Bearer tok"';

  it("W1497: claim hook env reaches before_doing commands — BOARD_*, COLUMN_*, AGENT_NAME, HOOK_NAME", async () => {
    const dir = await initRepo();
    try {
      const hooks = await instantiate(dir);
      writeFileSync(
        join(dir, ".stride.md"),
        '## before_doing\n\n```bash\nprintf \'%s|%s|%s|%s|%s|%s\' "$BOARD_ID" "$BOARD_NAME" "$COLUMN_ID" "$COLUMN_NAME" "$AGENT_NAME" "$HOOK_NAME" > board.txt\n```\n',
      );
      const claimResponse = JSON.stringify({
        data: { id: 42, identifier: "W42", title: "T", status: "in_progress" },
        hook: {
          name: "before_doing",
          env: {
            HOOK_NAME: "before_doing",
            AGENT_NAME: "oc",
            BOARD_ID: "7",
            BOARD_NAME: "Main Board",
            COLUMN_ID: "3",
            COLUMN_NAME: "Doing",
          },
        },
      });
      await hooks["tool.execute.after"]({ input: { command: CLAIM_CMD } }, claimResponse);
      expect(readFileSync(join(dir, "board.txt"), "utf8")).toBe(
        "7|Main Board|3|Doing|oc|before_doing",
      );
    } finally {
      cleanup(dir);
    }
  });

  it("W1497: server value wins over the derived one, persists to the cache — but HOOK_NAME does not persist", async () => {
    const dir = await initRepo();
    try {
      const hooks = await instantiate(dir);
      const claimResponse = JSON.stringify({
        data: { id: 42, identifier: "W42", title: "Derived", status: "in_progress" },
        hook: {
          name: "before_doing",
          env: {
            HOOK_NAME: "before_doing",
            TASK_TITLE: "ServerWins",
            BOARD_ID: "7",
            TASK_BASE_REF: "bogus",
          },
        },
      });
      await hooks["tool.execute.after"]({ input: { command: CLAIM_CMD } }, claimResponse);
      const cache = JSON.parse(readFileSync(join(dir, ".stride-env-cache"), "utf8"));
      expect(cache.TASK_TITLE).toBe("ServerWins");
      expect(cache.BOARD_ID).toBe("7");
      expect("HOOK_NAME" in cache).toBe(false);
      // TASK_BASE_REF stays client-derived (a real git SHA, not "bogus").
      expect(cache.TASK_BASE_REF).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      cleanup(dir);
    }
  });

  it("W1497: after_goal entry env reaches after_goal commands — and only after_goal commands", async () => {
    const dir = await initRepo();
    try {
      const hooks = await instantiate(dir);
      writeFileSync(
        join(dir, ".stride.md"),
        '## before_review\n\n```bash\nprintf \'%s\' "${GOAL_ID:-unset}" > goalcheck.txt\n```\n\n## after_goal\n\n```bash\necho "goal=$GOAL_ID/$GOAL_IDENTIFIER"\n```\n',
      );
      const completeResponse = JSON.stringify({
        data: { id: 42 },
        hooks: [
          { name: "before_review", env: { BOARD_ID: "7" } },
          { name: "after_goal", env: { GOAL_ID: "9", GOAL_IDENTIFIER: "G9" } },
        ],
      });
      const origOut = process.stdout.write.bind(process.stdout);
      let stdoutCap = "";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stdout as any).write = (chunk: unknown) => { stdoutCap += String(chunk); return true; };
      try {
        await hooks["tool.execute.after"](
          { input: { command: COMPLETE_CMD } },
          completeResponse,
        );
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (process.stdout as any).write = origOut;
      }
      // GOAL_* did NOT reach the primary before_review command…
      expect(readFileSync(join(dir, "goalcheck.txt"), "utf8")).toBe("unset");
      // …but did reach the after_goal command.
      const line = stdoutCap.split("\n").find((l) => l.includes('"hook":"after_goal"'));
      expect(line).toBeDefined();
      const parsed = JSON.parse(line as string);
      expect(parsed.status).toBe("success");
      expect(parsed.commands_output[0].stdout).toBe("goal=9/G9\n");
      // …and never landed in the persisted cache.
      if (existsSync(join(dir, ".stride-env-cache"))) {
        const cache = JSON.parse(readFileSync(join(dir, ".stride-env-cache"), "utf8"));
        expect("GOAL_ID" in cache).toBe(false);
      }
    } finally {
      cleanup(dir);
    }
  });

  it("W1497: a response without hooks behaves exactly as today (fallback derivation)", async () => {
    const dir = await initRepo();
    try {
      const hooks = await instantiate(dir);
      const claimResponse = JSON.stringify({
        data: { id: 42, identifier: "W42", title: "T", status: "in_progress" },
      });
      await hooks["tool.execute.after"]({ input: { command: CLAIM_CMD } }, claimResponse);
      writeFileSync(
        join(dir, ".stride.md"),
        '## before_review\n\n```bash\nprintf \'%s\' "$TASK_ID" > board.txt\n```\n',
      );
      await hooks["tool.execute.after"]({ input: { command: COMPLETE_CMD } }, "");
      expect(readFileSync(join(dir, "board.txt"), "utf8")).toBe("42");
    } finally {
      cleanup(dir);
    }
  });

  it("W1497: env values containing newlines arrive byte-for-byte", async () => {
    const dir = await initRepo();
    try {
      const hooks = await instantiate(dir);
      writeFileSync(
        join(dir, ".stride.md"),
        '## before_doing\n\n```bash\nprintf \'%s\' "$BOARD_NAME" > board.txt\n```\n',
      );
      const claimResponse = JSON.stringify({
        data: { id: 42, identifier: "W42", title: "T", status: "in_progress" },
        hook: {
          name: "before_doing",
          env: { BOARD_NAME: "line1\nline2" },
        },
      });
      await hooks["tool.execute.after"]({ input: { command: CLAIM_CMD } }, claimResponse);
      expect(readFileSync(join(dir, "board.txt"), "utf8")).toBe("line1\nline2");
    } finally {
      cleanup(dir);
    }
  });

  it("W1497: an after_goal entry with an empty env still routes and succeeds", async () => {
    const dir = await initRepo();
    try {
      const hooks = await instantiate(dir);
      writeFileSync(join(dir, ".stride.md"), "## after_goal\n\n```bash\necho ok\n```\n");
      const origOut = process.stdout.write.bind(process.stdout);
      let stdoutCap = "";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stdout as any).write = (chunk: unknown) => { stdoutCap += String(chunk); return true; };
      try {
        await hooks["tool.execute.after"](
          { input: { command: COMPLETE_CMD } },
          JSON.stringify({ hooks: [{ name: "after_goal", env: {} }] }),
        );
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (process.stdout as any).write = origOut;
      }
      const line = stdoutCap.split("\n").find((l) => l.includes('"hook":"after_goal"'));
      expect(line).toBeDefined();
      expect(JSON.parse(line as string).status).toBe("success");
    } finally {
      cleanup(dir);
    }
  });
});

// The canonical-file preference for after_goal detection + GOAL_* env (W1637).
// The API curl tees the FULL response to .stride/.last-api-response.json, so
// when opencode hands the plugin a truncated `output`, detection and env
// extraction must still succeed by reading the file first.
describe("StridePlugin — W1637 canonical response file preference", () => {
  const originalFetch = globalThis.fetch;

  async function initRepo(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "stride-oc-w1637-"));
    await $`git init -q`.cwd(dir).quiet();
    await $`git config user.email "test@test.local"`.cwd(dir).quiet();
    await $`git config user.name "Test"`.cwd(dir).quiet();
    writeFileSync(
      join(dir, ".gitignore"),
      ".stride.md\n.stride-changed-files.json\n.stride-diff-upload-state\n.stride-env-cache\n.stride/\n",
    );
    writeFileSync(join(dir, "tracked.txt"), "v1\n");
    await $`git add .gitignore tracked.txt`.cwd(dir).quiet();
    await $`git commit -q -m v1`.cwd(dir).quiet();
    return dir;
  }
  function cleanup(dir: string): void {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  async function instantiate(dir: string) {
    return (await StridePlugin({ directory: dir, worktree: dir, $ } as never)) as {
      "tool.execute.before": (i: unknown, o?: unknown) => Promise<void>;
      "tool.execute.after": (i: unknown, o?: unknown) => Promise<void>;
    };
  }

  const COMPLETE_CMD =
    'curl -X PATCH http://localhost/api/tasks/42/complete -H "Authorization: Bearer tok"';

  // A full /complete response bundling an after_goal entry with GOAL_* env.
  function fullResponse(goalIdentifier: string): string {
    return JSON.stringify({
      data: { id: 42, identifier: "W42", status: "completed" },
      hooks: [
        { name: "after_goal", env: { GOAL_ID: "4969", GOAL_IDENTIFIER: goalIdentifier } },
      ],
    });
  }

  // Write the .stride.md after_goal section that echoes the GOAL_IDENTIFIER so
  // the emitted HookResult proves which env reached the command.
  function writeAfterGoalSection(dir: string): void {
    writeFileSync(
      join(dir, ".stride.md"),
      '## after_goal\n\n```bash\necho "goal=$GOAL_IDENTIFIER"\n```\n',
    );
  }

  // Run tool.execute.after capturing stdout; return the parsed after_goal
  // HookResult line, or undefined when the after_goal hook never fired.
  async function runAfter(
    hooks: { "tool.execute.after": (i: unknown, o?: unknown) => Promise<void> },
    output: unknown,
  ): Promise<Record<string, unknown> | undefined> {
    const origOut = process.stdout.write.bind(process.stdout);
    let stdoutCap = "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = (chunk: unknown) => { stdoutCap += String(chunk); return true; };
    try {
      await hooks["tool.execute.after"]({ input: { command: COMPLETE_CMD } }, output);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stdout as any).write = origOut;
    }
    const line = stdoutCap.split("\n").find((l) => l.includes('"hook":"after_goal"'));
    return line ? (JSON.parse(line) as Record<string, unknown>) : undefined;
  }

  beforeEach(() => {
    // The before_review self-heal may resolve creds and attempt a PUT; stub
    // fetch so no test touches the network.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async () => new Response("", { status: 200 });
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("detects after_goal and forwards GOAL_* env from the file under a TRUNCATED output", async () => {
    const dir = await initRepo();
    try {
      const hooks = await instantiate(dir);
      writeAfterGoalSection(dir);
      // The curl tee'd the full response to the canonical file...
      mkdirSync(join(dir, ".stride"), { recursive: true });
      writeFileSync(join(dir, CANONICAL_RESPONSE_FILE), fullResponse("G227") + "\n");
      // ...but opencode handed the plugin a truncated (invalid-JSON) output.
      const truncated = fullResponse("G227").slice(0, 40);
      const result = await runAfter(hooks, truncated);
      expect(result).toBeDefined();
      expect(result!.status).toBe("success");
      // GOAL_IDENTIFIER came from the canonical file, not the truncated output.
      const commandsOutput = result!.commands_output as { stdout: string }[];
      expect(commandsOutput[0].stdout).toBe("goal=G227\n");
    } finally {
      cleanup(dir);
    }
  });

  it("captures a complete valid output to the canonical file", async () => {
    const dir = await initRepo();
    try {
      const hooks = await instantiate(dir);
      writeAfterGoalSection(dir);
      // No pre-existing file — a valid output must be captured to it.
      expect(existsSync(join(dir, CANONICAL_RESPONSE_FILE))).toBe(false);
      const result = await runAfter(hooks, fullResponse("G227"));
      expect(existsSync(join(dir, CANONICAL_RESPONSE_FILE))).toBe(true);
      const captured = JSON.parse(readFileSync(join(dir, CANONICAL_RESPONSE_FILE), "utf8"));
      expect(captured).toEqual(JSON.parse(fullResponse("G227")));
      // And detection still fires (back-compat: valid output alone works).
      expect(result?.status).toBe("success");
    } finally {
      cleanup(dir);
    }
  });

  it("a valid current output overwrites a stale prior-call canonical file", async () => {
    const dir = await initRepo();
    try {
      const hooks = await instantiate(dir);
      writeAfterGoalSection(dir);
      // A stale file names a different goal...
      mkdirSync(join(dir, ".stride"), { recursive: true });
      writeFileSync(join(dir, CANONICAL_RESPONSE_FILE), fullResponse("G_STALE") + "\n");
      // ...the current VALID output must overwrite it and its env must win.
      const result = await runAfter(hooks, fullResponse("G227"));
      const captured = JSON.parse(readFileSync(join(dir, CANONICAL_RESPONSE_FILE), "utf8"));
      expect(captured.hooks[0].env.GOAL_IDENTIFIER).toBe("G227");
      const commandsOutput = result!.commands_output as { stdout: string }[];
      expect(commandsOutput[0].stdout).toBe("goal=G227\n");
    } finally {
      cleanup(dir);
    }
  });

  it("heals an invalid-JSON canonical file from a valid output", async () => {
    const dir = await initRepo();
    try {
      const hooks = await instantiate(dir);
      writeAfterGoalSection(dir);
      // A corrupt/truncated prior file must not break detection when the
      // current output is valid — the capture overwrites it with valid JSON.
      mkdirSync(join(dir, ".stride"), { recursive: true });
      writeFileSync(join(dir, CANONICAL_RESPONSE_FILE), "{corrupt");
      const result = await runAfter(hooks, fullResponse("G227"));
      expect(result?.status).toBe("success");
      const captured = JSON.parse(readFileSync(join(dir, CANONICAL_RESPONSE_FILE), "utf8"));
      expect(captured.hooks[0].env.GOAL_IDENTIFIER).toBe("G227");
    } finally {
      cleanup(dir);
    }
  });

  it("does NOT fire after_goal when the output is truncated and no file is present (grace-worker path)", async () => {
    const dir = await initRepo();
    try {
      const hooks = await instantiate(dir);
      writeAfterGoalSection(dir);
      // No canonical file and a truncated output → nothing to detect. The
      // server's grace-window worker promotes the goal instead.
      const truncated = fullResponse("G227").slice(0, 40);
      const result = await runAfter(hooks, truncated);
      expect(result).toBeUndefined();
      // And a truncated output must not have written a garbage file.
      expect(existsSync(join(dir, CANONICAL_RESPONSE_FILE))).toBe(false);
    } finally {
      cleanup(dir);
    }
  });
});

// The hook-initiated fresh GET /api/tasks/:id/after_goal_status is the
// reliability guarantee (W1638 / stride D119): because the plugin captures
// whatever truncatable output the host hands it, the output and the canonical
// file are both best-effort. Keyed off the claim-cached TASK_ID, the fresh GET
// detects an armed after_goal independent of both — de-duped against the fast
// path and best-effort if unreachable.
describe("StridePlugin — W1638 fresh-GET after_goal reliability fallback", () => {
  const originalFetch = globalThis.fetch;
  let fetchUrls: string[] = [];
  let afterGoalStatus: () => Response | never;

  const COMPLETE_CMD =
    'curl -X PATCH http://localhost/api/tasks/42/complete -H "Authorization: Bearer tok"';

  async function initRepo(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "stride-oc-w1638-"));
    await $`git init -q`.cwd(dir).quiet();
    await $`git config user.email "test@test.local"`.cwd(dir).quiet();
    await $`git config user.name "Test"`.cwd(dir).quiet();
    writeFileSync(
      join(dir, ".gitignore"),
      ".stride.md\n.stride-changed-files.json\n.stride-diff-upload-state\n.stride-env-cache\n.stride/\n",
    );
    writeFileSync(join(dir, "tracked.txt"), "v1\n");
    await $`git add .gitignore tracked.txt`.cwd(dir).quiet();
    await $`git commit -q -m v1`.cwd(dir).quiet();
    return dir;
  }
  function cleanup(dir: string): void {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  async function instantiate(dir: string) {
    return (await StridePlugin({ directory: dir, worktree: dir, $ } as never)) as {
      "tool.execute.after": (i: unknown, o?: unknown) => Promise<void>;
    };
  }
  // Seed the claim env cache directly so TASK_ID is present without running a
  // full claim (a claim would also capture its response to the canonical file,
  // muddying the "no file" scenarios).
  function seedTaskId(dir: string): void {
    writeFileSync(join(dir, ".stride-env-cache"), JSON.stringify({ TASK_ID: "42" }) + "\n");
  }
  function writeAfterGoalSection(dir: string, body = 'echo "goal=$GOAL_IDENTIFIER"'): void {
    writeFileSync(join(dir, ".stride.md"), `## after_goal\n\n\`\`\`bash\n${body}\n\`\`\`\n`);
  }
  function fullResponseWithAfterGoal(goalIdentifier: string): string {
    return JSON.stringify({
      data: { id: 42, status: "completed" },
      hooks: [
        { name: "after_goal", env: { GOAL_ID: "4969", GOAL_IDENTIFIER: goalIdentifier } },
      ],
    });
  }
  async function runAfterHook(
    hooks: { "tool.execute.after": (i: unknown, o?: unknown) => Promise<void> },
    command: string,
    output: unknown,
  ): Promise<Record<string, unknown> | undefined> {
    const origOut = process.stdout.write.bind(process.stdout);
    let stdoutCap = "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = (chunk: unknown) => { stdoutCap += String(chunk); return true; };
    try {
      await hooks["tool.execute.after"]({ input: { command } }, output);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stdout as any).write = origOut;
    }
    const line = stdoutCap.split("\n").find((l) => l.includes('"hook":"after_goal"'));
    return line ? (JSON.parse(line) as Record<string, unknown>) : undefined;
  }
  async function runComplete(
    hooks: { "tool.execute.after": (i: unknown, o?: unknown) => Promise<void> },
    output: unknown,
  ): Promise<Record<string, unknown> | undefined> {
    return runAfterHook(hooks, COMPLETE_CMD, output);
  }
  const calledStatus = () => fetchUrls.some((u) => u.includes("/after_goal_status"));

  beforeEach(() => {
    fetchUrls = [];
    // Default: the server reports an armed after_goal with GOAL_* env.
    afterGoalStatus = () =>
      new Response(
        JSON.stringify({
          after_goal_armed: true,
          goal_id: "4969",
          env: { GOAL_ID: "4969", GOAL_IDENTIFIER: "G227" },
        }),
        { status: 200 },
      );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async (url: string) => {
      const u = String(url);
      fetchUrls.push(u);
      if (u.includes("/after_goal_status")) return afterGoalStatus();
      // Any other call (the before_review self-heal changed_files PUT) succeeds.
      return new Response("", { status: 200 });
    };
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("fires after_goal via the fresh GET under a fully truncated output with no file", async () => {
    const dir = await initRepo();
    try {
      seedTaskId(dir);
      const hooks = await instantiate(dir);
      writeAfterGoalSection(dir);
      // No canonical file, and a truncated (invalid-JSON) output — the fast
      // path can detect nothing, so only the fresh GET can arm after_goal.
      const truncated = fullResponseWithAfterGoal("G227").slice(0, 40);
      const result = await runComplete(hooks, truncated);
      expect(calledStatus()).toBe(true);
      expect(result?.status).toBe("success");
      const commandsOutput = result!.commands_output as { stdout: string }[];
      expect(commandsOutput[0].stdout).toBe("goal=G227\n");
      // The truncated output must not have written a canonical file.
      expect(existsSync(join(dir, CANONICAL_RESPONSE_FILE))).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  it("does not run after_goal when the fresh GET reports armed=false", async () => {
    const dir = await initRepo();
    try {
      seedTaskId(dir);
      afterGoalStatus = () =>
        new Response(JSON.stringify({ after_goal_armed: false }), { status: 200 });
      const hooks = await instantiate(dir);
      writeAfterGoalSection(dir);
      const result = await runComplete(hooks, fullResponseWithAfterGoal("G227").slice(0, 40));
      expect(calledStatus()).toBe(true);
      expect(result).toBeUndefined();
    } finally {
      cleanup(dir);
    }
  });

  it("de-dups: when the fast path fires, the fresh GET is NOT called", async () => {
    const dir = await initRepo();
    try {
      seedTaskId(dir);
      const hooks = await instantiate(dir);
      writeAfterGoalSection(dir);
      // A complete, valid output carrying after_goal — the fast path handles it.
      // The distinct identifier proves the env came from the output, not the GET
      // (which would return G227).
      const result = await runComplete(hooks, fullResponseWithAfterGoal("G_FAST"));
      const commandsOutput = result!.commands_output as { stdout: string }[];
      expect(commandsOutput[0].stdout).toBe("goal=G_FAST\n");
      // The reliability GET must never fire when the fast path already ran.
      expect(calledStatus()).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  it("is a silent no-op when the after_goal_status endpoint is unreachable", async () => {
    const dir = await initRepo();
    try {
      seedTaskId(dir);
      afterGoalStatus = () => {
        throw new Error("ECONNREFUSED");
      };
      const hooks = await instantiate(dir);
      writeAfterGoalSection(dir);
      // No throw, and after_goal simply does not run.
      const result = await runComplete(hooks, fullResponseWithAfterGoal("G227").slice(0, 40));
      expect(calledStatus()).toBe(true);
      expect(result).toBeUndefined();
    } finally {
      cleanup(dir);
    }
  });

  it("falls back to the result goalId for GOAL_ID when the env omits it", async () => {
    const dir = await initRepo();
    try {
      seedTaskId(dir);
      // Armed, with goal_id set but GOAL_ID absent from the hook env.
      afterGoalStatus = () =>
        new Response(
          JSON.stringify({
            after_goal_armed: true,
            goal_id: "4969",
            env: { GOAL_IDENTIFIER: "G227" },
          }),
          { status: 200 },
        );
      const hooks = await instantiate(dir);
      writeAfterGoalSection(dir, 'echo "gid=$GOAL_ID"');
      const result = await runComplete(hooks, fullResponseWithAfterGoal("G227").slice(0, 40));
      const commandsOutput = result!.commands_output as { stdout: string }[];
      expect(commandsOutput[0].stdout).toBe("gid=4969\n");
    } finally {
      cleanup(dir);
    }
  });

  it("does not run the fresh GET when TASK_ID was never cached", async () => {
    const dir = await initRepo();
    try {
      // No seedTaskId → envCache has no TASK_ID → the fallback short-circuits.
      const hooks = await instantiate(dir);
      writeAfterGoalSection(dir);
      const result = await runComplete(hooks, fullResponseWithAfterGoal("G227").slice(0, 40));
      expect(calledStatus()).toBe(false);
      expect(result).toBeUndefined();
    } finally {
      cleanup(dir);
    }
  });

  it("still fires on a truncated /mark_reviewed even though after_review clears the cache", async () => {
    const dir = await initRepo();
    try {
      // TASK_ID is captured BEFORE the after_review cleanup wipes envCache
      // (memory + disk), so the fresh GET survives on the /mark_reviewed path.
      seedTaskId(dir);
      const hooks = await instantiate(dir);
      writeAfterGoalSection(dir);
      const MARK_REVIEWED_CMD =
        'curl -X PATCH http://localhost/api/tasks/42/mark_reviewed -H "Authorization: Bearer tok"';
      const result = await runAfterHook(
        hooks,
        MARK_REVIEWED_CMD,
        fullResponseWithAfterGoal("G227").slice(0, 40),
      );
      expect(calledStatus()).toBe(true);
      expect(result?.status).toBe("success");
      const commandsOutput = result!.commands_output as { stdout: string }[];
      expect(commandsOutput[0].stdout).toBe("goal=G227\n");
      // And the after_review cleanup still removed the persisted cache.
      expect(existsSync(join(dir, ".stride-env-cache"))).toBe(false);
    } finally {
      cleanup(dir);
    }
  });
});

// End-to-end after_goal reliability under truncation (W1639 / stride W1612):
// exercises the full claim -> /complete lifecycle through tool.execute.after,
// proving the section runs and GOAL_* is exported when the host hands the
// plugin a truncated output, with the canonical file (or the fresh GET) as the
// source of truth. All side effects are stubbed — no real push, no real server.
describe("StridePlugin — W1639 end-to-end after_goal under truncation", () => {
  const originalFetch = globalThis.fetch;
  let fetchUrls: string[] = [];
  let afterGoalStatus: () => Response;

  const CLAIM_CMD =
    'curl -X POST http://localhost/api/tasks/claim -H "Authorization: Bearer tok"';
  const COMPLETE_CMD =
    'curl -X PATCH http://localhost/api/tasks/42/complete -H "Authorization: Bearer tok"';
  const CLAIM_RESPONSE = JSON.stringify({
    data: { id: 42, identifier: "W42", title: "T", status: "in_progress" },
  });

  async function initRepo(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "stride-oc-w1639-"));
    await $`git init -q`.cwd(dir).quiet();
    await $`git config user.email "test@test.local"`.cwd(dir).quiet();
    await $`git config user.name "Test"`.cwd(dir).quiet();
    writeFileSync(
      join(dir, ".gitignore"),
      ".stride.md\n.stride-changed-files.json\n.stride-diff-upload-state\n.stride-env-cache\n.stride/\n",
    );
    writeFileSync(join(dir, "tracked.txt"), "v1\n");
    await $`git add .gitignore tracked.txt`.cwd(dir).quiet();
    await $`git commit -q -m v1`.cwd(dir).quiet();
    return dir;
  }
  function cleanup(dir: string): void {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  async function instantiate(dir: string) {
    return (await StridePlugin({ directory: dir, worktree: dir, $ } as never)) as {
      "tool.execute.after": (i: unknown, o?: unknown) => Promise<void>;
    };
  }
  function writeAfterGoalSection(dir: string, body = 'echo "goal=$GOAL_IDENTIFIER"'): void {
    writeFileSync(join(dir, ".stride.md"), `## after_goal\n\n\`\`\`bash\n${body}\n\`\`\`\n`);
  }
  // The full /complete response the agent's curl tees to the canonical file.
  function completeResponseWithAfterGoal(goalIdentifier: string): string {
    return JSON.stringify({
      data: { id: 42, identifier: "W42", status: "completed" },
      hooks: [
        { name: "after_doing", env: {} },
        { name: "before_review", env: {} },
        { name: "after_review", env: {} },
        { name: "after_goal", env: { GOAL_ID: "4969", GOAL_IDENTIFIER: goalIdentifier } },
      ],
    });
  }
  async function runComplete(
    hooks: { "tool.execute.after": (i: unknown, o?: unknown) => Promise<void> },
    output: unknown,
  ): Promise<Record<string, unknown> | undefined> {
    const origOut = process.stdout.write.bind(process.stdout);
    let stdoutCap = "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = (chunk: unknown) => { stdoutCap += String(chunk); return true; };
    try {
      await hooks["tool.execute.after"]({ input: { command: COMPLETE_CMD } }, output);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stdout as any).write = origOut;
    }
    const line = stdoutCap.split("\n").find((l) => l.includes('"hook":"after_goal"'));
    return line ? (JSON.parse(line) as Record<string, unknown>) : undefined;
  }
  const calledStatus = () => fetchUrls.some((u) => u.includes("/after_goal_status"));

  beforeEach(() => {
    fetchUrls = [];
    afterGoalStatus = () =>
      new Response(
        JSON.stringify({ after_goal_armed: false }),
        { status: 200 },
      );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async (url: string) => {
      const u = String(url);
      fetchUrls.push(u);
      if (u.includes("/after_goal_status")) return afterGoalStatus();
      return new Response("", { status: 200 });
    };
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("claim -> truncated /complete with the full response tee'd to the file runs after_goal + exports GOAL_*", async () => {
    const dir = await initRepo();
    try {
      const hooks = await instantiate(dir);
      // 1. Real claim populates the env cache (TASK_ID, TASK_BASE_REF).
      await hooks["tool.execute.after"]({ input: { command: CLAIM_CMD } }, CLAIM_RESPONSE);
      // 2. The agent's /complete curl tees the FULL response to the canonical
      //    file (overwriting the claim response the plugin captured).
      mkdirSync(join(dir, ".stride"), { recursive: true });
      writeFileSync(
        join(dir, CANONICAL_RESPONSE_FILE),
        completeResponseWithAfterGoal("G227") + "\n",
      );
      writeAfterGoalSection(dir);
      // 3. opencode hands the plugin a truncated (invalid-JSON) output.
      const truncated = completeResponseWithAfterGoal("G227").slice(0, 50);
      const result = await runComplete(hooks, truncated);
      // The section ran (fast path from the file) and GOAL_IDENTIFIER was
      // exported to it.
      expect(result?.status).toBe("success");
      const commandsOutput = result!.commands_output as { stdout: string }[];
      expect(commandsOutput[0].stdout).toBe("goal=G227\n");
      // The fast path handled it — no fresh GET was needed.
      expect(calledStatus()).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  it("a present file with after_goal but no ## after_goal section is a clean no-op", async () => {
    const dir = await initRepo();
    try {
      const hooks = await instantiate(dir);
      await hooks["tool.execute.after"]({ input: { command: CLAIM_CMD } }, CLAIM_RESPONSE);
      mkdirSync(join(dir, ".stride"), { recursive: true });
      writeFileSync(
        join(dir, CANONICAL_RESPONSE_FILE),
        completeResponseWithAfterGoal("G227") + "\n",
      );
      // .stride.md exists but has NO after_goal section.
      writeFileSync(join(dir, ".stride.md"), "## before_review\n\n```bash\n```\n");
      const result = await runComplete(hooks, completeResponseWithAfterGoal("G227").slice(0, 50));
      // Detected, but nothing to run — a silent no-op (grace worker promotes).
      expect(result).toBeUndefined();
      // No fresh GET either: the fast path DETECTED after_goal, it just had no
      // commands, so the fallback must not fire.
      expect(calledStatus()).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  it("no file + truncated output + armed=false GET does not false-positive", async () => {
    const dir = await initRepo();
    try {
      const hooks = await instantiate(dir);
      await hooks["tool.execute.after"]({ input: { command: CLAIM_CMD } }, CLAIM_RESPONSE);
      writeAfterGoalSection(dir);
      // No canonical file (the claim's capture is the only writer, but the
      // /complete tee never happened) + a truncated output. The control: the
      // server reports not-armed, so after_goal must NOT run.
      rmSync(join(dir, CANONICAL_RESPONSE_FILE), { force: true });
      const result = await runComplete(hooks, completeResponseWithAfterGoal("G227").slice(0, 50));
      expect(calledStatus()).toBe(true);
      expect(result).toBeUndefined();
    } finally {
      cleanup(dir);
    }
  });

  it("no file + truncated output + armed GET with GOAL_ID omitted uses the goalId fallback", async () => {
    const dir = await initRepo();
    try {
      const hooks = await instantiate(dir);
      await hooks["tool.execute.after"]({ input: { command: CLAIM_CMD } }, CLAIM_RESPONSE);
      writeAfterGoalSection(dir, 'echo "gid=$GOAL_ID"');
      rmSync(join(dir, CANONICAL_RESPONSE_FILE), { force: true });
      // Armed, goal_id present but GOAL_ID absent from the hook env.
      afterGoalStatus = () =>
        new Response(
          JSON.stringify({ after_goal_armed: true, goal_id: "4969", env: { GOAL_IDENTIFIER: "G227" } }),
          { status: 200 },
        );
      const result = await runComplete(hooks, completeResponseWithAfterGoal("G227").slice(0, 50));
      const commandsOutput = result!.commands_output as { stdout: string }[];
      expect(commandsOutput[0].stdout).toBe("gid=4969\n");
    } finally {
      cleanup(dir);
    }
  });
});
