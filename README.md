# Stride for OpenCode

Task lifecycle skills, custom agents, and hook execution for [Stride](https://www.stridelikeaboss.com) kanban — a task management platform designed for AI agents.

This is the OpenCode version of the Stride plugin. It provides workflow enforcement through OpenCode's skill and custom agent systems, plus a native TypeScript plugin for automatic hook execution.

## Installation

### Via npm (recommended)

Add the plugin to your project's `opencode.json`:

```json
{
  "plugin": ["opencode-stride"]
}
```

OpenCode installs npm plugins automatically using Bun at startup.

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

### Automatic (with plugin installed)

When the opencode-stride npm plugin is installed, hooks execute automatically:

- **Claim API call** → `tool.execute.after` fires → runs `before_doing` from `.stride.md`
- **Complete API call** → `tool.execute.before` fires → runs `after_doing` (blocks on failure) → then `tool.execute.after` fires → runs `before_review`
- **Mark reviewed API call** → `tool.execute.after` fires → runs `after_review`

Agents should make API calls directly — the plugin handles hook execution transparently.

### Manual (without plugin)

Read `.stride.md` and execute each hook command line by line. Hooks are pre-authorized by the user who authored them — no confirmation needed.

## Hook Lifecycle

| Hook | When | Blocking | Timeout |
|------|------|----------|---------|
| `before_doing` | After claiming a task | Yes | 60s |
| `after_doing` | Before marking complete | Yes | 120s |
| `before_review` | After marking complete | Yes | 60s |
| `after_review` | After review approval | Yes | 60s |

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

## License

MIT
