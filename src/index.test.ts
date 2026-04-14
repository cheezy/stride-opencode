import { describe, expect, it } from "bun:test";
import {
  parseStrideMd,
  filterCommands,
  detectHook,
  extractEnvFromResponse,
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
