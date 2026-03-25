# Stride Plugin for OpenCode

Task lifecycle skills and agents for the [Stride](https://www.stridelikeaboss.com) kanban system, packaged for [OpenCode](https://opencode.ai).

## Installation

### Via opencode.json (recommended)

Add the plugin to your project's `opencode.json`:

```json
{
  "plugin": ["opencode-stride"]
}
```

### Via local directory

Copy the `skills/` and `agents/` directories into your project:

```
.opencode/
  skills/
    stride-claiming-tasks/SKILL.md
    stride-completing-tasks/SKILL.md
    stride-creating-goals/SKILL.md
    stride-creating-tasks/SKILL.md
    stride-enriching-tasks/SKILL.md
    stride-subagent-workflow/SKILL.md
  agents/
    task-explorer.md
    task-reviewer.md
    task-decomposer.md
    hook-diagnostician.md
```

## Skills

| Skill | Purpose |
|-------|---------|
| `stride-claiming-tasks` | Claim tasks with proper hook execution |
| `stride-completing-tasks` | Complete tasks with validation and review hooks |
| `stride-creating-tasks` | Create work tasks and defects with correct field formats |
| `stride-creating-goals` | Create goals with batch upload and dependency ordering |
| `stride-enriching-tasks` | Enrich minimal tasks with codebase-derived context |
| `stride-subagent-workflow` | Dispatch exploration and review agents |

## Agents

| Agent | Purpose |
|-------|---------|
| `task-explorer` | Explore key files and patterns before implementation |
| `task-reviewer` | Review changes against acceptance criteria |
| `task-decomposer` | Break goals into dependency-ordered child tasks |
| `hook-diagnostician` | Diagnose hook failures with prioritized fix plans |

## Setup

1. Create `.stride_auth.md` with your API credentials (never commit this file)
2. Create `.stride.md` with your hook definitions
3. Add `.stride_auth.md` to `.gitignore`

## License

MIT
