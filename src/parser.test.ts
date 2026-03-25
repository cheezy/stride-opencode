import { describe, expect, it } from "bun:test";
import { parseStrideMd, buildCommandList } from "./parser";

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

describe("parseStrideMd", () => {
  it("parses before_doing from basic .stride.md", () => {
    const commands = parseStrideMd(sampleMd, "before_doing");
    expect(commands).toEqual([
      "git pull origin main",
      "mix deps.get",
      "mix ecto.migrate",
    ]);
  });

  it("parses all 4 hook sections", () => {
    expect(parseStrideMd(sampleMd, "before_doing")).toHaveLength(3);
    expect(parseStrideMd(sampleMd, "after_doing")).toHaveLength(4);
    expect(parseStrideMd(sampleMd, "before_review")).toHaveLength(3);
    expect(parseStrideMd(sampleMd, "after_review")).toHaveLength(4);
  });

  it("sections do not bleed into each other", () => {
    const beforeDoing = parseStrideMd(sampleMd, "before_doing");
    expect(beforeDoing).not.toContain("mix test --cover");
    expect(beforeDoing).not.toContain("git fetch origin");

    const afterDoing = parseStrideMd(sampleMd, "after_doing");
    expect(afterDoing).not.toContain("git pull origin main");
    expect(afterDoing).not.toContain("git fetch origin");
  });

  it("missing hook returns empty array", () => {
    const result = parseStrideMd("## other\n\n```bash\nfoo\n```", "before_doing");
    expect(result).toEqual([]);
  });

  it("empty code block returns empty array", () => {
    const md = "## before_doing\n\n```bash\n```\n";
    expect(parseStrideMd(md, "before_doing")).toEqual([]);
  });

  it("comments and blank lines filtered", () => {
    const md =
      "## before_doing\n\n```bash\n# comment\ngit pull\n\n# another\nmix deps.get\n```\n";
    expect(parseStrideMd(md, "before_doing")).toEqual([
      "git pull",
      "mix deps.get",
    ]);
  });

  it("leading whitespace trimmed", () => {
    const md = "## before_doing\n\n```bash\n  git pull  \n\tmix deps.get\n```\n";
    expect(parseStrideMd(md, "before_doing")).toEqual([
      "git pull",
      "mix deps.get",
    ]);
  });

  it("only first code block captured", () => {
    const md =
      "## before_doing\n\n```bash\ncmd1\n```\n\nSome text\n\n```bash\ncmd2\n```\n## after_doing\n";
    expect(parseStrideMd(md, "before_doing")).toEqual(["cmd1"]);
  });

  it("adjacent sections without blank lines", () => {
    const md =
      "## before_doing\n```bash\ncmd1\n```\n## after_doing\n```bash\ncmd2\n```\n";
    expect(parseStrideMd(md, "before_doing")).toEqual(["cmd1"]);
    expect(parseStrideMd(md, "after_doing")).toEqual(["cmd2"]);
  });

  it("handles CRLF line endings", () => {
    const crlfMd =
      "## before_doing\r\n\r\n```bash\r\ngit pull\r\nmix deps.get\r\n```\r\n";
    expect(parseStrideMd(crlfMd, "before_doing")).toEqual([
      "git pull",
      "mix deps.get",
    ]);
  });

  it("handles no trailing newline", () => {
    const md = "## before_doing\n\n```bash\ngit pull\n```";
    expect(parseStrideMd(md, "before_doing")).toEqual(["git pull"]);
  });

  it("section with no bash block returns empty array", () => {
    const md = "## before_doing\n\nSome descriptive text\n\n## after_doing\n";
    expect(parseStrideMd(md, "before_doing")).toEqual([]);
  });

  it("handles trailing whitespace on section headings", () => {
    const md = "## before_doing   \n\n```bash\ngit pull\n```\n";
    expect(parseStrideMd(md, "before_doing")).toEqual(["git pull"]);
  });

  it("handles .stride.md with only some hooks defined", () => {
    const md = "## before_doing\n\n```bash\ngit pull\n```\n";
    expect(parseStrideMd(md, "before_doing")).toEqual(["git pull"]);
    expect(parseStrideMd(md, "after_doing")).toEqual([]);
    expect(parseStrideMd(md, "before_review")).toEqual([]);
    expect(parseStrideMd(md, "after_review")).toEqual([]);
  });

  it("handles multiple code blocks in one section (only first)", () => {
    const md = `## before_doing

\`\`\`bash
first_cmd
\`\`\`

Some explanation text

\`\`\`bash
second_cmd
\`\`\`

## after_doing
`;
    expect(parseStrideMd(md, "before_doing")).toEqual(["first_cmd"]);
  });

  it("handles section with text but no code block", () => {
    const md = `## before_doing

This section has text but no code block.
It just explains things.

## after_doing

\`\`\`bash
real_cmd
\`\`\`
`;
    expect(parseStrideMd(md, "before_doing")).toEqual([]);
    expect(parseStrideMd(md, "after_doing")).toEqual(["real_cmd"]);
  });
});

describe("buildCommandList", () => {
  it("removes empty lines", () => {
    expect(buildCommandList(["cmd1", "", "cmd2", "  "])).toEqual([
      "cmd1",
      "cmd2",
    ]);
  });

  it("removes comment lines", () => {
    expect(buildCommandList(["# comment", "cmd1", "# another"])).toEqual([
      "cmd1",
    ]);
  });

  it("trims whitespace", () => {
    expect(buildCommandList(["  cmd1  ", "\tcmd2\t"])).toEqual([
      "cmd1",
      "cmd2",
    ]);
  });

  it("returns empty array for all comments", () => {
    expect(buildCommandList(["# comment", "# another"])).toEqual([]);
  });

  it("returns empty array for empty input", () => {
    expect(buildCommandList([])).toEqual([]);
  });
});
