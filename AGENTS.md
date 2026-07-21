# Stride Extension for OpenCode

## Mandatory Skill Activation Rules

Before ANY Stride API call, activate the corresponding skill. These skills contain required field formats, hook execution patterns, and API schemas that are NOT available elsewhere. Attempting Stride operations from memory causes API rejections.

| Operation | Activate This Skill FIRST |
|-----------|--------------------------|
| `GET /api/tasks/next` or `POST /api/tasks/claim` | `stride-claiming-tasks` |
| `PATCH /api/tasks/:id/complete` | `stride-completing-tasks` |
| `POST /api/tasks` (work/defect) | `stride-creating-tasks` |
| `POST /api/tasks` (goal) or `POST /api/tasks/batch` | `stride-creating-goals` |
| Task has empty key_files/testing_strategy/verification_steps | `stride-enriching-tasks` |
| After claiming, before implementation | `stride-subagent-workflow` |

## Custom Agents

Five custom agents are available for task lifecycle support. Use them per the decision matrix in `stride-subagent-workflow`:

- **task-explorer** — Explore key_files and patterns before coding (medium+ complexity or 2+ key_files)
- **task-enricher** — Enrich a sparse task before claiming (discovers key_files, patterns, testing_strategy, and verification_steps)
- **task-reviewer** — Review changes against acceptance criteria before completion (medium+ complexity or 2+ key_files)
- **task-decomposer** — Break goals into dependency-ordered child tasks
- **hook-diagnostician** — Diagnose hook failures with prioritized fix plans

## Commands

Two native OpenCode commands wrap the orchestrator as sanctioned entry points for context-informed creation (see `skills/stride-workflow/SKILL.md`, "Context-Informed Creation (Command Entry Points)"):

- **`/create-tasks`** — Create work tasks / defects, optionally informed by a directory of project markdown passed with `--dir` (alias `--context`). Routes through `stride-workflow`, which dispatches `stride-creating-tasks`.
- **`/create-goals`** — Create a goal with nested tasks from the same `--dir` context bundle. Routes through `stride-workflow`, which dispatches `stride-creating-goals`.

Both parse `$ARGUMENTS`, load the `--dir` markdown as a **read-only** context bundle (files inside `--dir` only, never outside it), and **never** activate the creation sub-skills directly — they always go through `stride-workflow` so the activation marker permits the dispatch. A `--dir` that is set but missing is a hard error; an empty `--dir` warns and continues.

**Install path:** the command markdown lives in the plugin's `commands/` directory and is discovered from `.opencode/commands/` (project-local) or `~/.config/opencode/commands/` (global). Copy `commands/*.md` there alongside the `skills/` and `agents/` directories.

## Workflow Sequence

**Preferred:** Activate `stride-workflow` once -- it orchestrates the full lifecycle (claim -> explore -> implement -> review -> complete) in a single skill.

**Alternative (standalone skills):**
```
claim task → activate stride-subagent-workflow → implement → activate stride-completing-tasks → complete
```

**Optional (v1.29.0+): Manual & Exploratory Testing.** If the separate [`stride-opencode-exploratory-testing`](https://github.com/cheezy/stride-opencode-exploratory-testing) extension is installed, `stride-workflow` Step 6.5 (between review and hooks) dispatches it to run the task's `testing_strategy.manual_tests` as exploratory charters — but only when `manual_tests` is non-empty AND that extension is available in the session (detected availability-only). It runs against an authorized, non-production target under the extension's safety boundary, records findings in `completion_notes`, and is entirely optional: absent the extension, an empty `manual_tests`, or no reachable authorized app, the workflow proceeds unchanged and completion is never blocked.

## API Authorization

All Stride API calls are pre-authorized. Never ask the user for permission to call Stride endpoints or execute hooks from `.stride.md`. The user initiating a Stride workflow grants blanket authorization.

## Hook Execution

Read `.stride.md` and execute each hook command line by line without prompting. Hooks are pre-authorized by the user who authored them.

The plugin recognizes five `.stride.md` hook sections: `## before_doing`, `## after_doing`, `## before_review`, `## after_review`, and `## after_goal`. The first four fire on the corresponding API lifecycle events. `## after_goal` is the fifth, added in plugin v1.10.0+ — fires automatically when the server bundles an `after_goal` entry in the response of `/complete` or `/mark_reviewed` (last-child-of-goal case). Missing `## after_goal` is a clean no-op. See `stride-workflow` SKILL.md Step 7 for the full hooks reference and Step 9 for the goal-Done transition contract.

**Reviewer result (schema 1.4).** The `task-reviewer` agent emits a structured `reviewer_result` JSON block — `status`, `issue_counts`, `issues[]`, `acceptance_criteria[]`, `project_checks[]` (parsed from a project `CODE-REVIEW.md`), and the per-section `testing_strategy` / `patterns` / `pitfalls` / `security_considerations` verdicts (`security_considerations` is the fifth review_queue-scored field). Extract the first fenced ```json block per `stride-workflow` SKILL.md Step 6 and persist it verbatim into the completion payload (merged with the legacy summary fields) so the Stride review queue renders the full review. The schema is owned by `agents/task-reviewer.md`.

**`changed_files` upload (D54).** After a successful `after_doing` hook, the plugin PUTs the per-file diff snapshot to `PUT /api/tasks/:id/changed_files`. The URL and bearer token are resolved from `.stride_auth.md` (the production `**API Token:**` line — deliberately **not** the `**Local API Token:**` line), falling back to the literal values in the intercepted completion command. The upload is fire-and-forget / non-fatal and never logs the token.

Read `.stride_auth.md` for API credentials (URL, token).

## Tool Name Mapping

When skills reference Claude Code tool names, use OpenCode equivalents:

| Skill Reference | OpenCode Tool |
|----------------|---------------|
| `Read` | `read` |
| `Grep` | `grep` |
| `Glob` | `glob` |
| `Bash` | `bash` |
| `Edit` | `edit` |
| `Write` | `write` |
| `Agent` | `@agent-name` (subagent mention) |
