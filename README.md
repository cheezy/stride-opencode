# Stride for OpenCode

Task lifecycle skills, custom agents, and hook execution for [Stride](https://www.stridelikeaboss.com) kanban — a task management platform designed for AI agents.

This is the OpenCode version of the Stride plugin. It provides workflow enforcement through OpenCode's skill and custom agent systems, plus a native TypeScript plugin for automatic hook execution.

## Installation

### Via GitHub (recommended)

Add the plugin to your project's `opencode.json`:

```json
{
  "plugin": ["github:cheezy/stride-opencode"]
}
```

OpenCode installs plugins automatically using Bun at startup.

### Via npm

If the package is published to npm, you can also use:

```json
{
  "plugin": ["opencode-stride"]
}
```

### Via local directory

Copy the plugin files into your project's `.opencode/` directory:

```bash
git clone https://github.com/cheezy/stride-opencode.git

# Copy skills
cp -r stride-opencode/skills/ .opencode/skills/

# Copy agents
cp -r stride-opencode/agents/ .opencode/agents/

# Copy AGENTS.md
cp stride-opencode/AGENTS.md AGENTS.md
```

OpenCode discovers skills in `.opencode/skills/` and agents in `.opencode/agents/` automatically.

## Setup

Before using the plugin, create two configuration files in your project root:

### 1. `.stride_auth.md` (required, never commit)

```markdown
- **API URL:** `https://www.stridelikeaboss.com`
- **API Token:** `stride_dev_your_token_here`
- **User Email:** `your-email@example.com`
```

Add `.stride_auth.md` to your `.gitignore` — it contains secrets.

### 2. `.stride.md` (required, version controlled)

Define hook commands that run at each lifecycle point:

```markdown
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
\`\`\`

## before_review

\`\`\`bash
git fetch origin
git rebase origin/main
mix test
\`\`\`

## after_review

\`\`\`bash
git push origin main
\`\`\`
```

## Mandatory Skill Chain

Every Stride skill is **mandatory** — not optional. Each skill contains required API fields, hook execution patterns, and validation rules that are only documented in that skill. Attempting to call Stride API endpoints without the corresponding skill results in API rejections.

### Workflow Order

When working on tasks, skills must be activated in this order:

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
| `stride-claiming-tasks` | `GET /api/tasks/next` or `POST /api/tasks/claim` | Claim tasks with proper hook execution and before_doing result |
| `stride-completing-tasks` | `PATCH /api/tasks/:id/complete` | Complete tasks with after_doing/before_review hooks and all required fields |
| `stride-creating-tasks` | `POST /api/tasks` (work/defect) | Create tasks with correct field formats (object arrays, not strings) |
| `stride-creating-goals` | `POST /api/tasks/batch` | Create goals with batch format (root key must be "goals") |
| `stride-enriching-tasks` | Task has empty key_files/testing_strategy | Transform minimal specs into complete implementation-ready tasks |
| `stride-subagent-workflow` | After claiming, before implementation | Decision matrix for dispatching explorer/reviewer/decomposer agents |

## Agents

| Agent | Mode | Purpose |
|-------|------|---------|
| `task-explorer` | subagent | Explore key_files and patterns before implementation |
| `task-reviewer` | subagent | Review changes against acceptance criteria before completion |
| `task-decomposer` | subagent | Break goals into dependency-ordered child tasks |
| `hook-diagnostician` | subagent | Diagnose hook failures with prioritized fix plans |

Agents are invoked via `@mention` in chat (e.g., `@task-explorer`) or automatically by the `stride-subagent-workflow` skill based on task complexity.

## Hook Execution

The plugin provides automatic hook execution — a native TypeScript implementation that intercepts Stride API calls and runs `.stride.md` commands without any external shell scripts or configuration files.

### How It Works

The plugin subscribes to OpenCode's `tool.execute.before` and `tool.execute.after` events. When an agent makes a Stride API call via `curl` or any shell command, the plugin:

1. Detects the Stride API endpoint in the command
2. Routes to the correct `.stride.md` section based on the endpoint and event timing
3. Executes each command from the section sequentially
4. Blocks the API call on failure (for pre-execution hooks) or logs warnings (for post-execution hooks)

### Hook Routing

| API Call | Event | Hook Executed |
|----------|-------|---------------|
| `POST /api/tasks/claim` | `tool.execute.after` | `before_doing` |
| `PATCH /api/tasks/:id/complete` | `tool.execute.before` | `after_doing` (blocks on failure) |
| `PATCH /api/tasks/:id/complete` | `tool.execute.after` | `before_review` |
| `PATCH /api/tasks/:id/mark_reviewed` | `tool.execute.after` | `after_review` |

Non-Stride commands pass through without any intervention.

### Hook Lifecycle

| Hook | When | Blocking | Timeout |
|------|------|----------|---------|
| `before_doing` | After claiming a task | Yes | 60s |
| `after_doing` | Before marking complete | Yes | 120s |
| `before_review` | After marking complete | Yes | 60s |
| `after_review` | After review approval | Yes | 60s |

**Blocking hooks** prevent the API call from proceeding if any command fails. The agent receives a structured error with the failed command, exit code, and output.

### `.stride.md` Format

Each hook section is a `## heading` followed by a ````bash` code block:

```markdown
## before_doing

`​``bash
git pull origin main
mix deps.get
`​``
```

**Parser rules:**
- Only the first ````bash` block per section is executed
- Lines starting with `#` are treated as comments and skipped
- Blank lines are skipped
- Commands execute one at a time, stopping on first failure
- Both LF and CRLF line endings are supported
- Sections you don't need can be omitted entirely

### Advantages Over Shell-Based Hooks

Unlike shell-script hooks used on other platforms, the OpenCode plugin approach offers:

- **Cross-platform** — runs on macOS, Linux, and Windows without separate `.sh` and `.ps1` scripts
- **Native JSON** — parses API responses directly without `jq` dependency
- **Single file** — no external hook scripts, configuration files, or shell wrappers
- **Structured errors** — returns typed error objects instead of parsing stderr text
- **Environment caching** — automatically extracts task metadata from claim responses and makes it available as environment variables (`$TASK_ID`, `$TASK_IDENTIFIER`, `$TASK_TITLE`, etc.) in subsequent hooks

### Manual Hook Execution (Without Plugin)

If the npm plugin is not installed, agents can execute hooks manually by reading `.stride.md` and running each command line by line. Hooks are pre-authorized by the user who authored them — no confirmation prompts needed.

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

### Hooks not firing

- Verify the plugin is listed in `opencode.json`: `"plugin": ["opencode-stride"]`
- Confirm `.stride.md` exists in the project root
- Check that the hook section has a ````bash` code block (not just text)

### Hook command fails

- The plugin executes commands sequentially and stops on first failure
- Check the error output for the specific command that failed
- Fix the issue and retry the API call — the hooks will fire again automatically

### Missing environment variables in hooks

- Environment variables (`$TASK_ID`, `$TASK_TITLE`, etc.) are extracted from the claim API response
- They are only available after a successful claim in the same session
- If variables are missing, the claim response may not have included the expected fields

### Skills not discovered

- For npm installation: verify `opencode.json` has the plugin listed
- For local installation: verify skills are in `.opencode/skills/<name>/SKILL.md`
- Skill names must be lowercase alphanumeric with hyphens, matching their directory name

### Agents not available

- For npm installation: agents are loaded from the plugin's `agents/` directory automatically
- For local installation: copy agent files to `.opencode/agents/<name>.md`
- Invoke agents via `@agent-name` in chat

## License

MIT
