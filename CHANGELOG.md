# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.5.0] - 2026-04-29

### Added

- **`src/skill-gate.ts`** — Layer-1 enforcement gate ported from stride 1.10.0 (commit 5c30036). Two exports: `gateSkillActivation(input)` is a pure function that takes `{skillName, projectDir, env, now, fs}` and returns `"allow"` or `{decision: "block", reason: string}`. `gateToolCall(toolName, toolArgs, projectDir, env, now)` handles wiring: matches `toolName` against `SKILL_ACTIVATION_TOOLS` (a permissive list — `skill`, `activate_skill`, `loadSkill`, `load_skill` — until opencode's exact skill-activation tool name is documented), tries arg field names in order (`name`, `skill`, `skillName`, `skill_name`), and delegates to `gateSkillActivation`. Marker contract is byte-identical to stride 1.10.0: path `<project>/.stride/.orchestrator_active`, JSON `{session_id, started_at, pid}`, 4-hour freshness window, `STRIDE_ALLOW_DIRECT=1` bypass. When the agent attempts to activate any internal Stride sub-skill (`stride-claiming-tasks`, `stride-completing-tasks`, `stride-creating-tasks`, `stride-creating-goals`, `stride-enriching-tasks`, `stride-subagent-workflow`) directly from a user prompt, the gate throws an `Error` with a structured JSON body so opencode's plugin runtime blocks the activation; orchestrator-dispatched activations pass through silently.
- **`src/skill-gate.test.ts`** — 47-assertion test suite covering the 7 stride 1.10.0 scenarios plus edge cases: marker missing → block, marker fresh → allow (including the exact 4h boundary), marker stale or in the future → block, marker unparseable JSON → block, `stride-workflow` always allowed (with or without marker, bare or namespaced), non-Stride skills always allowed, `STRIDE_ALLOW_DIRECT=1` bypasses (and only `=1`, not other truthy strings), every protected sub-skill in both bare and `stride:` namespaced forms, every wiring tool name and arg field name. Tests use `bun:test` describe/it style matching the existing `parser.test.ts` and isolate fs state via `mkdtempSync` per case.
- **`src/skill-gate.ts` exports re-exported from `src/index.ts`** — `gateSkillActivation`, `gateToolCall`, `SKILL_ACTIVATION_TOOLS`, `PROTECTED_SUB_SKILLS` are now importable from `opencode-stride` for downstream consumers.
- **`skills/stride-workflow/SKILL.md` Orchestrator Activation Marker section** — New section between API Authorization and When to Activate documents the marker contract with an OpenCode-specific project-root resolution paragraph (`${OPENCODE_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$(pwd)}}`). Step 0 (Prerequisites) gained a marker-write block; Step 9 (Post-Completion) gained a "Clearing the Orchestrator Activation Marker" subsection. Marker fields are byte-identical to stride 1.10.0 so cross-plugin tooling can rely on the same path and JSON shape.
- **`## STOP — orchestrator check` preamble** — Inserted as the first H2 of every sub-skill body (6 files). The 5-line block tells an agent that arrived at a sub-skill directly to back out and activate `stride:stride-workflow` instead.

### Changed

- **All 6 sub-skill `description:` fields** (`stride-claiming-tasks`, `stride-completing-tasks`, `stride-creating-tasks`, `stride-creating-goals`, `stride-enriching-tasks`, `stride-subagent-workflow`) — Reframed as `INTERNAL — invoked only by stride:stride-workflow. Do NOT invoke from a user prompt.` Removed user-intent verbs so OpenCode's auto-activation matcher no longer routes user prompts to the sub-skills. Wording is byte-identical to stride 1.10.0 for cross-plugin consistency. The opencode-specific frontmatter fields (`license`, `compatibility`, `metadata.category`, `metadata.version`) are preserved untouched on every file.
- **`stride-workflow` `description:`** — Amplified to enumerate the explicit user-intent phrases that should match the orchestrator: "claim a task", "work on the next stride task", "complete a stride task", "enrich a stride task", "decompose a goal", "create a goal or stride tasks". The phrase list is load-bearing for OpenCode's matcher and should not be diluted.
- **`src/index.ts` Plugin export** — `tool.execute.before` now invokes the skill-activation gate before the existing bash-hook routing. Non-skill tool calls and non-Stride skills fall through to the bash-hook flow unchanged. Added explicit type casts to the existing `input.input.command` and `output.result` accesses so `bunx tsc --noEmit` runs clean against `@opencode-ai/plugin@1.x` types; runtime semantics of the bash hook are unchanged.

### Source

Motivated by the three-layer defense designed in `docs/plans/stride-plugin-feedback.md` (kanban repo) and ported from stride 1.10.0 (commit 5c30036). Layer 1 (the runtime gate) is now active on OpenCode; Layers 2 (description reframing) and 3 (STOP preamble) have always been runtime-independent and are also in place.

## [1.4.0] - 2026-04-16

### Added

- **`stride-completing-tasks` skill** — Surfaced `explorer_result` and `reviewer_result` in six places so agents cannot forget them: (1) the MANDATORY teaser at the top of the skill lists both as required alongside the hook results; (2) the pre-completion Verification Checklist asks whether both are included; (3) the primary API Request Format example includes both in the self-reported skip shape (OpenCode's weaker custom-agent support makes skip the primary path); (4) a new "Explorer/Reviewer Result Schema" section leads with the skip shape, then documents the dispatched shape, the five-value skip-reason enum (`no_subagent_support`, `small_task_0_1_key_files`, `trivial_change_docs_only`, `self_reported_exploration`, `self_reported_review`), the 40-character non-whitespace summary minimum, a 422 rejection example, and the feature-flag grace-period rollout; (5) the Completion Request Field Reference table lists both as required objects; (6) the Quick Reference Card's `REQUIRED BODY` includes both plus a SKIP FORM snippet.
- **`stride-workflow` skill** — Step 8's Required Fields table and JSON payload example now include `explorer_result` and `reviewer_result` using the skip shape as the default. A new "Explorer and Reviewer Result Rollout" section after "Workflow Telemetry" describes the grace-mode/strict-mode feature-flag phases and directs readers to `stride-completing-tasks` for the full shape (no schema duplication). Orchestrator prose explains that Steps 3 and 6 already produce the data needed to populate these fields in Step 8, and that the skip form is the default path on OpenCode.

## [1.3.0] - 2026-04-14

### Added

- **`stride-workflow` skill** — New "Workflow Telemetry: The `workflow_steps` Array" section documenting the six-entry step-name vocabulary (`explorer`, `planner`, `implementation`, `reviewer`, `after_doing`, `before_review`), per-step schema (`name`, `dispatched`, `duration_ms`, `reason`), full-dispatch and skipped-step examples, and rules for assembling the array. Step names are identical to the main stride plugin so Stride can aggregate telemetry across agents and plugins.
- **`stride-completing-tasks` skill** — `workflow_steps` now appears in the verification checklist, the API Request Format example, the Completion Request Field Reference table, and the Quick Reference Card REQUIRED BODY. Added a Schema Reference paragraph pointing at `stride-workflow` as the source of truth for the array shape.

### Changed

- **`stride-completing-tasks` skill** — "Critical" note under the payload example now lists `workflow_steps` alongside the two hook-result fields as required. The API will reject completions that omit it.

## [1.2.1] - 2026-04-14

### Fixed

- **`src/index.ts` (`extractEnvFromResponse`)** — Now handles the `{"stdout": "<api-json-string>", ...}` wrapper shape that some hosts use when passing the tool response to hooks. The function previously tried `parsed.data || parsed`, which missed the wrapper entirely — leaving `TASK_IDENTIFIER`/`TASK_TITLE` unset for downstream `.stride.md` commands. It now peels `.stdout` and parses the inner JSON as a first step, then falls back to the two legacy shapes (`{data:{...}}` and `{id:...}`).
- **`src/index.test.ts`** — New regression tests for the wrapped `tool_response.stdout` shape (wrapped with `.data` and wrapped flat).

## [1.2.0] - 2026-04-13

### Changed

- **`stride-claiming-tasks`** — Replaced soft "Recommended" orchestrator section with non-negotiable "YOUR NEXT STEP" gate demanding stride-workflow activation immediately after claiming. Added workflow violation warning to standalone mode.
- **`stride-completing-tasks`** — Added "BEFORE CALLING COMPLETE: Verification Checklist" with 4 yes/no items covering orchestrator activation, codebase exploration, acceptance criteria review, and hook readiness.

## [1.1.0] - 2026-04-13

### Added

- **`stride-workflow` skill** — Single orchestrator for the complete Stride task lifecycle adapted for OpenCode. Walks through prerequisites, claiming, codebase exploration (via custom agents with graceful fallback), implementation, code review, hooks, and completion in a single skill. Uses automatic hook execution via `tool.execute.before`/`tool.execute.after` and process-over-speed messaging.

### Changed

- **`stride-claiming-tasks` skill** — Reframed automation notice from throughput-emphasizing ("FULLY AUTOMATED") to process-over-speed ("The workflow IS the automation"). Added "Recommended: Use the Workflow Orchestrator" section. Renamed "MANDATORY: Next Skill After Claiming" to "Next Skill After Claiming (Standalone Mode)".
- **`stride-completing-tasks` skill** — Reframed automation notice to process-over-speed. Added "Arriving from stride-workflow" section. Renamed "MANDATORY: Previous Skill Before Completing" to "Previous Skill Before Completing (Standalone Mode)".
- **`AGENTS.md`** — Updated Workflow Sequence to recommend `stride-workflow` as preferred entry point.
- **`README.md`** — Added `stride-workflow` to Workflow Order and Skills table.
- **`package.json`** — Bumped version from 1.0.0 to 1.1.0.

## [1.0.0] - 2026-03-25

### Added

**Plugin (`src/index.ts`)**
- TypeScript plugin with `tool.execute.before` and `tool.execute.after` hook handlers
- Automatic Stride API call detection for claim, complete, and mark_reviewed endpoints
- Hook routing: claim→before_doing, pre-complete→after_doing, post-complete→before_review, mark_reviewed→after_review
- Non-Stride commands pass through without intervention
- Missing `.stride.md` handled gracefully (no-op)

**Parser (`src/parser.ts`)**
- `.stride.md` parser supporting CRLF and LF line endings
- Extracts commands from `## section` + ````bash` code blocks
- Filters comments (lines starting with `#`) and blank lines
- Only captures first code block per section
- Handles adjacent sections, trailing whitespace, and missing trailing newlines

**Environment Variable Caching**
- Automatically extracts task metadata from claim API responses
- Caches `TASK_ID`, `TASK_IDENTIFIER`, `TASK_TITLE`, `TASK_STATUS`, `TASK_COMPLEXITY`, `TASK_PRIORITY`, `TASK_NEEDS_REVIEW`, `TASK_DESCRIPTION`
- Variables persist across hook invocations within a session
- Cache cleared after `after_review` (end of lifecycle)

**Skills (6)**
- `stride-claiming-tasks` — Task claiming with before_doing hook execution
- `stride-completing-tasks` — Task completion with after_doing and before_review hooks
- `stride-creating-tasks` — Task creation with field format validation
- `stride-creating-goals` — Goal and batch creation with dependency management
- `stride-enriching-tasks` — Automated codebase exploration to enrich minimal tasks
- `stride-subagent-workflow` — Decision matrix for agent dispatch based on complexity

**Agents (4)**
- `task-explorer` — Read-only codebase exploration for key_files and patterns
- `task-reviewer` — Code review against acceptance criteria, pitfalls, and patterns
- `task-decomposer` — Goal decomposition into dependency-ordered child tasks
- `hook-diagnostician` — Hook failure diagnosis with prioritized fix plans

**Configuration**
- `AGENTS.md` — OpenCode configuration bridge with skill activation rules and tool mapping
- `package.json` — npm package manifest (`opencode-stride`)
- `tsconfig.json` — TypeScript configuration for Bun runtime

**Documentation**
- `README.md` — Installation (npm and local), skill chain, hooks, agents, troubleshooting
- `CHANGELOG.md` — This file

**Tests**
- 49 tests across 2 test files using `bun:test` runner
- Parser tests: 21 tests covering all edge cases
- Plugin tests: 28 tests covering routing, filtering, and environment extraction
