# Stride for OpenCode

Task lifecycle skills, custom subagents, and automatic hook execution for [Stride](https://www.stridelikeaboss.com) kanban — adapted for [OpenCode](https://opencode.ai).

This plugin provides three things:

1. A **TypeScript plugin** that intercepts Stride API calls and runs `.stride.md` hooks automatically (via `tool.execute.before` / `tool.execute.after` events).
2. Seven **skills** (`stride-workflow` orchestrator plus six phase-specific skills) loaded into `.opencode/skills/` and invoked via OpenCode's native `skill` tool.
3. Five **subagents** (`task-explorer`, `task-enricher`, `task-reviewer`, `task-decomposer`, `hook-diagnostician`) loaded into `.opencode/agents/` and invoked via `@mention` in chat.

## Installation

Installation is **two separate steps** — the plugin and the skills/agents are distributed in the same repository but loaded by OpenCode through different mechanisms.

### Step 1 — Install the plugin (for automatic hook execution)

Add the plugin to your project's `opencode.json` or global `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["github:cheezy/stride-opencode"]
}
```

OpenCode installs plugins automatically using **Bun** at startup, caching them under `~/.cache/opencode/node_modules/`. See [OpenCode's plugins docs](https://opencode.ai/docs/plugins/) for details.

> **npm package status:** The `opencode-stride` npm package is not currently published. Use the `github:cheezy/stride-opencode` reference above. If you need pinning, add a ref: `github:cheezy/stride-opencode#v1.25.0` (branch, tag, or commit SHA). OpenCode's docs only document npm package names in `"plugin"`, but Bun resolves `github:owner/repo` references as npm-install targets, so this works.

Alternatively, if you prefer not to auto-install, clone the repo into a local plugin directory:

```bash
# Project-local plugin
git clone https://github.com/cheezy/stride-opencode.git .opencode/plugins/stride-opencode

# Or user-global plugin
git clone https://github.com/cheezy/stride-opencode.git ~/.config/opencode/plugins/stride-opencode
```

### Step 2 — Install the skills and subagents (for the workflow itself)

**Important:** OpenCode does NOT auto-discover skills or agents from inside an installed plugin. They must live on disk at the documented paths below, regardless of whether the plugin is installed via `github:` or locally.

Clone the repo and copy the skills/agents into your project:

```bash
# Clone once somewhere
git clone https://github.com/cheezy/stride-opencode.git /tmp/stride-opencode

# Copy the 7 skills (each is a directory with a SKILL.md)
mkdir -p .opencode/skills
cp -R /tmp/stride-opencode/skills/. .opencode/skills/

# Copy the 5 subagent markdown files
mkdir -p .opencode/agents
cp /tmp/stride-opencode/agents/*.md .opencode/agents/

# Copy the 2 native commands (/create-tasks, /create-goals)
mkdir -p .opencode/commands
cp /tmp/stride-opencode/commands/*.md .opencode/commands/

# Copy the project-level AGENTS.md (orientation for the main agent)
cp /tmp/stride-opencode/AGENTS.md AGENTS.md
```

For a **global** install (available to every project), mirror the same copy into `~/.config/opencode/`:

```bash
mkdir -p ~/.config/opencode/skills ~/.config/opencode/agents ~/.config/opencode/commands
cp -R /tmp/stride-opencode/skills/. ~/.config/opencode/skills/
cp /tmp/stride-opencode/agents/*.md ~/.config/opencode/agents/
cp /tmp/stride-opencode/commands/*.md ~/.config/opencode/commands/
```

Per [OpenCode's skills docs](https://opencode.ai/docs/skills/), skills are also discovered from `.claude/skills/` and `.agents/skills/` — so a project that already uses the Claude Code stride plugin will pick these up from the same `.claude/skills/` directory without a separate copy.

### Step 3 — Create the Stride config files (one-time per project)

Create `.stride_auth.md` and `.stride.md` at your project root (see [Setup](#setup) below).

## Setup

Before using the plugin, create two configuration files in your project root.

### 1. `.stride_auth.md` (required, never commit)

```markdown
- **API URL:** `https://www.stridelikeaboss.com`
- **API Token:** `stride_dev_your_token_here`
- **User Email:** `your-email@example.com`
```

Add `.stride_auth.md` to your `.gitignore` — it contains secrets.

### 2. `.stride.md` (required, version controlled)

Define hook commands that run at each lifecycle point. Each section is a `## heading` followed by a ```` ```bash ```` code block:

````markdown
## before_doing

```bash
git pull origin main
mix deps.get
mix ecto.migrate
```

## after_doing

```bash
mix test --cover
mix format --check-formatted
mix credo --strict
```

## before_review

```bash
git fetch origin
git rebase origin/main
mix test
```

## after_review

```bash
git push origin main
```

## after_goal

```bash
# Optional fifth hook — fires after the parent goal's final child task
# completes. Omit entirely for the back-compat no-op path.
./scripts/notify-team.sh "$GOAL_IDENTIFIER" "$GOAL_TITLE"
```
````

Omit any sections you don't need.

**`after_goal` (v1.10.0+):** the server bundles an `after_goal` entry alongside the primary hook in the response of `/complete` or `/mark_reviewed` when the completing task is the final child of a parent goal. The plugin auto-executes the local `## after_goal` section as a blocking hook (same shape as `after_doing`) and emits a structured JSON result on stdout. The agent forwards the result via `PATCH /api/tasks/:goal_id/after_goal` to flip the goal to Done. A missing `## after_goal` section is a clean no-op (back-compat). The hook receives `GOAL_ID` / `GOAL_IDENTIFIER` / `GOAL_TITLE` / `GOAL_DESCRIPTION` env vars from the server's `hook.env`, and is general-purpose — Slack notifications, artifact archival, release pipelines, project-level smoke tests are all valid uses, not just PR creation.

## Skill and Agent Discovery Paths

OpenCode walks up from the current working directory to the git worktree root looking for these directories. The first match wins per skill/agent name.

| Resource | Project-local paths (in discovery order) | Global paths |
|---|---|---|
| Skills | `.opencode/skills/<name>/SKILL.md`, `.claude/skills/<name>/SKILL.md`, `.agents/skills/<name>/SKILL.md` | `~/.config/opencode/skills/<name>/SKILL.md`, `~/.claude/skills/<name>/SKILL.md`, `~/.agents/skills/<name>/SKILL.md` |
| Subagents | `.opencode/agents/<name>.md` | `~/.config/opencode/agents/<name>.md` |
| AGENTS.md | Any parent directory up to the git root | Not applicable |

## Mandatory Skill Chain

Every Stride skill is **mandatory** — not optional. Each skill contains required API fields, hook execution patterns, and validation rules that are only documented in that skill. Attempting to call Stride API endpoints without the corresponding skill results in API rejections.

### Skill invocation

OpenCode skills are invoked explicitly via the native `skill` tool:

```
skill({ name: "stride-workflow" })
```

The agent reads the tool's description listing and invokes skills by name when their trigger condition matches. Start each Stride session by calling `skill({ name: "stride-workflow" })` — that orchestrator walks through the full lifecycle (claim → explore → implement → review → complete) in one skill and references the other six as needed.

### Workflow order

**Recommended:** orchestrator

```
stride-workflow                  ← Activate ONCE — handles claim → explore → implement → review → complete
```

**Standalone mode** (individual skills):

```
stride-claiming-tasks            ← BEFORE calling GET /api/tasks/next or POST /api/tasks/claim
    ↓
stride-subagent-workflow         ← AFTER claim succeeds, BEFORE implementation
    ↓
[implementation]
    ↓
stride-completing-tasks          ← BEFORE calling PATCH /api/tasks/:id/complete
```

When creating tasks or goals:

```
stride-creating-tasks            ← BEFORE calling POST /api/tasks (work/defect)
stride-creating-goals            ← BEFORE calling POST /api/tasks/batch (goals)
stride-enriching-tasks           ← WHEN a task has empty key_files/testing_strategy
```

## Skills

| Skill | Trigger | Purpose |
|-------|---------|---------|
| `stride-workflow` | Starting task work | **RECOMMENDED** — Single orchestrator for the full lifecycle |
| `stride-claiming-tasks` | `GET /api/tasks/next` or `POST /api/tasks/claim` | Claim tasks with proper hook execution and before_doing result |
| `stride-completing-tasks` | `PATCH /api/tasks/:id/complete` | Complete tasks with after_doing/before_review hooks and all required fields |
| `stride-creating-tasks` | `POST /api/tasks` (work/defect) | Create tasks with correct field formats (object arrays, not strings) |
| `stride-creating-goals` | `POST /api/tasks/batch` | Create goals with batch format (root key must be "goals") |
| `stride-enriching-tasks` | Task has empty key_files/testing_strategy | Transform minimal specs into complete implementation-ready tasks |
| `stride-subagent-workflow` | After claiming, before implementation | Decision matrix for dispatching explorer/reviewer/decomposer agents |

Each skill's frontmatter has a `name` (1–64 chars, lowercase alphanumeric with hyphens) matching its directory name and a `description` (1–1024 chars) that OpenCode surfaces in the `skill` tool listing so the agent can pick the right one.

The `stride-creating-tasks`, `stride-enriching-tasks`, and `stride-workflow` skills also document the optional `technical_details` task field — a free-form JSON object (no fixed keys) for any extra technical context (data shapes, gotchas, decisions, links). It is optional everywhere and is **not** one of the five review_queue-scored fields, so a blank value is never a scoring gap.

(v1.18.0+) The `stride-creating-tasks` and `stride-creating-goals` skills document the optional `created_by_agent` field — set it to the plugin's own agent name (`"OpenCode"`, the same value sent as `agent_name` on claim/complete) so the `/agents` feed attributes the creating agent instead of a `?`. It is create-only and forbidden on `PATCH`, and the server propagates a batch goal's value to every nested child task.

## Subagents

| Agent | Mode | Purpose |
|-------|------|---------|
| `task-explorer` | subagent | Explore key_files and patterns before implementation |
| `task-enricher` | subagent | Enrich a sparse task before claiming |
| `task-reviewer` | subagent | Review changes against acceptance criteria before completion |
| `task-decomposer` | subagent | Break goals into dependency-ordered child tasks |
| `hook-diagnostician` | subagent | Diagnose hook failures with prioritized fix plans |

Invoke agents via `@mention` in chat (e.g., `@task-explorer`) or automatically by the `stride-subagent-workflow` skill based on task complexity. See [OpenCode's agents docs](https://opencode.ai/docs/agents/) for the frontmatter fields supported (description, mode, model, temperature, permission).

The `task-reviewer` emits a structured `reviewer_result` JSON block (**schema 1.6**) — `status`, `issue_counts`, `issues[]`, `acceptance_criteria[]`, `project_checks[]` (parsed from a project `CODE-REVIEW.md`), and the per-section `testing_strategy` / `patterns` / `pitfalls` / `security_considerations` verdicts — `security_considerations` is the fifth review_queue-scored field. Since **schema 1.6**, the block may also carry an OPTIONAL top-level `behaviour_test_matrix` verdict — `{ status, note, rows[] }`, one echoed row per row of the task's own matrix — emitted only when the task supplied a `behaviour_test_matrix` and omitted entirely otherwise (never required). Since **schema 1.5**, the `security_considerations` verdict may also carry an OPTIONAL nested `considerations[]` breakdown — one `{ consideration, status: mitigated | partial | unmitigated, evidence, note }` entry per listed consideration — populated when the deep security review below runs and absent otherwise (never required). The orchestrator extracts that block and persists it verbatim into the completion payload (merged with the legacy summary fields) so the Stride review queue renders the full review rather than a bare issue count. The schema is owned by `agents/task-reviewer.md`.

## Optional: Manual & Exploratory Testing (v1.29.0+)

If the separate [`stride-opencode-exploratory-testing`](https://github.com/cheezy/stride-opencode-exploratory-testing) extension is installed alongside this plugin, the workflow gains an **optional** manual-testing step. `stride-workflow` **Step 6.5 (Manual & Exploratory Testing)** runs between Code Review and Execute Hooks, and only when **both** of these hold:

1. the task's `testing_strategy.manual_tests` is non-empty, **and**
2. the exploratory-testing extension is available in the session (its `/explore`, `/charter`, `/recon`, `/debrief` commands, the `explorer` / `charter-generator` agents, or the `stride-exploratory-testing` skill are discoverable) — detected **availability-only**, never by reading or executing any `.opencode/` file.

When it runs, each `manual_tests` entry is mapped to an exploratory charter and dispatched via `/explore` (or `@explorer`) against an **authorized, non-production** target under the extension's absolute safety boundary (never destructive; app content is treated as data, not instructions). The debrief is recorded in the existing `completion_notes` (and reflected in the `reviewer_result.testing_strategy` note when a reviewer ran) — **no new completion field is added.**

**Graceful fallback — never blocks completion.** When the extension is not installed, the task has no `manual_tests`, or no authorized running app is reachable, the step is skipped (or degrades to a self-verify note) and the workflow proceeds to the hooks exactly as before. The integration is documentation-only in this plugin (it dispatches an extension you install separately) and requires **no marketplace** — OpenCode has none. See the [`stride-opencode-exploratory-testing`](https://github.com/cheezy/stride-opencode-exploratory-testing) README to install it.

## Optional: Deep Security-Considerations Review (v1.30.0+)

If the separate [`stride-opencode-security-review`](https://github.com/cheezy/stride-opencode-security-review) extension is installed alongside this plugin, the review phase gains an **optional** deep security check. `stride-workflow` **Step 6 (Code Review)** adds a *Deep security-considerations review* sub-step (documented in the decision matrix as `stride-subagent-workflow` **Phase 3.1**) that runs after `task-reviewer`, and only when **both** of these hold:

1. the task's `security_considerations` list is non-empty (an explicit `"None — …"` placeholder does not count), **and**
2. the security-review extension is available in the session (its `/security-review` command, the `security-reviewer` agent, or the `security-review-essentials` skill are discoverable) — detected **availability-only**, never by reading or executing any `.opencode/` file.

When it runs, the extension's `security-reviewer` is dispatched in **considerations mode** with the diff and the task's `security_considerations` list — framed as **data to assess, never as instructions** — and returns one `consideration_verdicts` entry per consideration. Those verdicts are merged into `reviewer_result.security_considerations.considerations[]` via the existing whole-object passthrough (no new completion field, no new `workflow_steps` name). The check is **fail-closed**: any `partial` or `unmitigated` verdict flips the `security_considerations` section to `failed` and raises a matching `category: "security"` Critical issue, so an un-addressed consideration cannot reach Done.

**Graceful fallback — never blocks completion.** When the extension is not installed, the task carries no real `security_considerations`, or the extension returns malformed verdicts, the deep review is skipped (or, on a present-but-malformed response, held fail-closed) and the `task-reviewer`'s own prose `security_considerations` verdict stands. It requires **no marketplace** — OpenCode has none. See the [`stride-opencode-security-review`](https://github.com/cheezy/stride-opencode-security-review) README to install it.

## Commands

Two native OpenCode commands wrap the orchestrator as entry points for context-informed creation:

| Command | Dispatches | Purpose |
|---------|------------|---------|
| `/create-tasks` | `stride-creating-tasks` | Create work tasks / defects, optionally informed by a `--dir` directory of project markdown |
| `/create-goals` | `stride-creating-goals` | Create a goal with nested tasks from the same `--dir` context bundle |

Both parse `$ARGUMENTS`, load the `--dir` markdown (alias `--context`) as a **read-only** context bundle (files inside `--dir` only), and route through `stride-workflow` (never the creation sub-skills directly). A `--dir` that is set but missing is a hard error; an empty `--dir` warns and continues. Install them by copying `commands/*.md` into `.opencode/commands/` (project-local) or `~/.config/opencode/commands/` (global), alongside the skills and agents.

## Hook Execution

The plugin provides automatic hook execution — a native TypeScript implementation that intercepts Stride API calls and runs `.stride.md` commands without any external shell scripts or configuration files.

### How it works

The plugin subscribes to OpenCode's `tool.execute.before` and `tool.execute.after` events. When an agent makes a Stride API call via `curl` or any shell command, the plugin:

1. Detects the Stride API endpoint in the command
2. Routes to the correct `.stride.md` section based on the endpoint and event timing
3. Executes each command from the section sequentially
4. Blocks the API call on failure (for pre-execution hooks) or logs warnings (for post-execution hooks)

Non-Stride commands pass through without any intervention.

### Hook routing

| API Call | Event | Hook Executed |
|----------|-------|---------------|
| `POST /api/tasks/claim` | `tool.execute.after` | `before_doing` |
| `PATCH /api/tasks/:id/complete` | `tool.execute.before` | `after_doing` (blocks on failure) |
| `PATCH /api/tasks/:id/complete` | `tool.execute.after` | `before_review` |
| `PATCH /api/tasks/:id/mark_reviewed` | `tool.execute.after` | `after_review` |

### Hook lifecycle

| Hook | When | Blocking | Timeout |
|------|------|----------|---------|
| `before_doing` | After claiming a task | Yes | 60s |
| `after_doing` | Before marking complete | Yes | host-controlled |
| `before_review` | After marking complete | Yes | host-controlled |
| `after_review` | After review approval | Yes | host-controlled |

**Blocking hooks** prevent the API call from proceeding if any command fails. The agent receives a structured error with the failed command, exit code, and output.

**Hook time budget (no `hooks.json` to tune).** Unlike the shell-based plugins, the OpenCode variant has **no `hooks.json`** — hooks run inside the OpenCode `tool.execute.before`/`tool.execute.after` handlers, so the time budget is controlled by the host runtime, not by a plugin-side timeout field. The canonical plugins raised their `after_doing` `hooks.json` timeout from **120s to 300s** (W1096) to give heavy test/lint/build suites room to finish before the diff upload is captured; that change is **N/A for stride-opencode** — there is no plugin-side timeout to bump. Keep your `## after_doing` commands within whatever budget the host enforces; if a long suite risks being cut off, split or shorten it rather than expecting a plugin timeout knob.

**Per-file diff upload (`changed_files`).** After a successful `after_doing` hook, the plugin captures the per-file working-tree diff to `.stride-changed-files.json` and fire-and-forgets a `PUT /api/tasks/:id/changed_files` so the Stride review queue shows the agent's diff. The upload URL and bearer token are resolved from your project's `.stride_auth.md` (the production `**API Token:**` line — deliberately **not** the `**Local API Token:**` line), falling back to the literal URL/token in the intercepted completion command. The upload is non-fatal (a missing auth file, network error, or absent endpoint degrades silently) and never logs the token. If the upload is interrupted (e.g. the host cuts off a long `after_doing` run after the commit but before the PUT lands), the plugin records the attempt's task id and HTTP status in `.stride-diff-upload-state` and self-heals the upload on the next claim.

**Gitignored state artifacts.** `.stride-changed-files.json` (the captured per-file diff), `.stride-diff-upload-state` (the upload bookkeeping marker), and `.stride-env-cache` (the persisted claim env cache — task metadata such as `TASK_ID`, `TASK_IDENTIFIER`, `TASK_TITLE`, and `TASK_BASE_REF` from `POST /api/tasks/claim`, **never the API token**) are transient hook state, not source, and all three are listed in `.gitignore`. The first two are regenerated on every `after_doing` run; `.stride-env-cache` is written at claim, lazily reloaded after a plugin or session restart so a mid-task restart doesn't lose `TASK_ID`/`TASK_BASE_REF`, and cleared at `after_review`. Committing them would pollute diffs and could leak the previous task's working-tree contents, so they stay out of the `after_doing` auto-commit, out of the `changed_files` capture, and out of version control entirely.

### `.stride.md` parser rules

- Only the first ```` ```bash ```` block per section is executed
- Lines starting with `#` are treated as comments and skipped
- Blank lines are skipped
- Commands execute one at a time, stopping on first failure
- Both LF and CRLF line endings are supported
- Sections you don't need can be omitted entirely

### Advantages over shell-based hooks

Unlike shell-script hooks used on other platforms, the OpenCode plugin approach offers:

- **Cross-platform** — runs on macOS, Linux, and Windows without separate `.sh` and `.ps1` scripts
- **Native JSON** — parses API responses directly without `jq` dependency
- **Single file** — no external hook scripts, configuration files, or shell wrappers
- **Structured errors** — returns typed error objects instead of parsing stderr text
- **Environment caching** — automatically extracts task metadata from claim responses and makes it available as environment variables (`$TASK_ID`, `$TASK_IDENTIFIER`, `$TASK_TITLE`, etc.) in subsequent hooks

### Manual hook execution (without the plugin)

If you skipped Step 1 of the install, the agent can still execute hooks manually by reading `.stride.md` and running each command line by line. Hooks are pre-authorized by the user who authored them — no confirmation prompts needed.

## API Authorization

All Stride API calls are pre-authorized when the user initiates a Stride workflow. Agents should never prompt for permission to call Stride endpoints or execute hooks.

## Tool Name Mapping

When skills reference tool names from other platforms, use OpenCode equivalents:

| Skill Reference | OpenCode Tool |
|----------------|---------------|
| `Read` / `read_file` | `read` |
| `Grep` / `grep_search` | `grep` |
| `Glob` | `glob` |
| `Bash` / `run_shell_command` | `bash` |
| `Edit` / `replace` | `edit` |
| `Write` / `write_file` | `write` |
| `Agent` | `@agent-name` (subagent mention) |

## Troubleshooting

### Plugin not loading

- Verify `opencode.json` has the plugin listed: `"plugin": ["github:cheezy/stride-opencode"]`
- Check that the repo reference resolves: run `bun add github:cheezy/stride-opencode` in a scratch directory to confirm Bun can pull it
- Look for Bun install errors in OpenCode's startup output

### Hooks not firing

- Confirm the plugin (Step 1) is installed, not just the skills (Step 2). The skills alone don't execute hooks — they instruct the agent to do so.
- Confirm `.stride.md` exists in the project root
- Check that each hook section has a ```` ```bash ```` code block (not just prose)

### Hook command fails

- The plugin executes commands sequentially and stops on first failure
- Check the error output for the specific command that failed
- Fix the issue and retry the API call — the hooks will fire again automatically

### Missing environment variables in hooks

- Environment variables (`$TASK_ID`, `$TASK_TITLE`, etc.) are extracted from the claim API response
- They are only available after a successful claim in the same session
- If variables are missing, the claim response may not have included the expected fields

### Skills not discovered

- Verify the skills are on disk at `.opencode/skills/<name>/SKILL.md` (project) or `~/.config/opencode/skills/<name>/SKILL.md` (global). **The `github:` plugin install does not place skills there — see Step 2.**
- Skill names must match their directory name exactly (1–64 chars, lowercase alphanumeric with hyphens)
- Verify frontmatter has `name:` and `description:` fields; unknown fields are ignored

### Subagents not available

- Verify agent files are at `.opencode/agents/<name>.md` or `~/.config/opencode/agents/<name>.md`
- Invoke agents via `@agent-name` in chat
- Check frontmatter has `description:` and `mode: subagent`

### `npm` package `opencode-stride` is missing

The npm package isn't currently published. Use the `github:cheezy/stride-opencode` reference in `opencode.json` instead, or install locally per Step 1. This README will be updated with the npm install form once the package ships.

## License

MIT
