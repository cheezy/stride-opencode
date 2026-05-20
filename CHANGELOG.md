# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.9.0] - 2026-05-20

### Added

- **`src/capture.ts`** — New module implementing `captureChangedFiles($, cwd, base)` per the G148/W719 contract with the Option D working-tree semantic landed under G157/W758. TypeScript port of the canonical bash `capture_changed_files()` in `stride/hooks/stride-hook.sh` v1.15.0. Uses `git diff $base` (no `..HEAD`) so committed + staged + modified-uncommitted all surface in a single pass; adds `git ls-files --others --exclude-standard` for untracked-new files synthesized via `git diff --no-index --no-color /dev/null <file>` (text → `+++ b/<path>` patch; binary → placeholder, detected via the `Binary files ... differ` sentinel). Tracked binaries are detected via the `- -` marker in `git diff --numstat`. Dedupes paths that are both committed-since-base AND further modified in the working tree (Set-based, exactly one entry per path, final working-tree diff). Truncates over-500-line diffs with the contract marker; falls back to `HEAD~1` when the base is empty or unresolvable. Returns `[]` for any degraded path and NEVER throws.
- **`src/index.ts`** — Wired the capture into the plugin lifecycle. `tool.execute.after` for `before_doing` captures `TASK_BASE_REF` via `git rev-parse HEAD` into the in-memory `envCache` AND removes any stale `.stride-changed-files.json` from a prior task. `tool.execute.before` for `after_doing` invokes `captureChangedFiles` and writes the JSON array to `$PROJECT_DIR/.stride-changed-files.json` after the `after_doing` commands succeed (and also writes when the user's after_doing block is empty/all-commented, so /complete still sees a populated snapshot). `tool.execute.after` for `after_review` cleans up the snapshot alongside the existing `envCache` reset.
- **`src/capture.test.ts`** — 12 new tests across 4 describe blocks: degraded paths, Option D semantic (modified-uncommitted, staged-uncommitted, untracked text, untracked binary, tracked binary, dedupe), truncation (under-MAX preserved, over-MAX truncated with marker), base-ref fallback. Full suite reports 87 passed / 0 failed (up from 75).
- **`skills/stride-completing-tasks/SKILL.md`** — New pre-completion checklist item testing for the inline `--argjson cf` pattern with absolute `$CLAUDE_PROJECT_DIR` path. The API Request Format section is rewritten to lead with a bash/curl block that inlines the snapshot read inside `jq -n --argjson cf "$(cat \"$CLAUDE_PROJECT_DIR/.stride-changed-files.json\" 2>/dev/null || echo '[]')"`, with the JSON body shape kept below as an illustrative supplement. New `## Per-File Diff Capture (Optional)` section cites `docs/diff-contract.md` and contains both a "Why inline?" paragraph (explaining the `tool.execute.before`-on-complete trigger) and a "Working-tree semantic (v1.9.0+)" paragraph documenting the broadened capture.

### Changed

- **`package.json`** — Version bumped from `1.8.0` to `1.9.0` (semantic broadening; the wire shape of `changed_files` is unchanged).

### Why this release

Other Stride plugins ship a `hooks/stride-hook.sh` that the host CLI fires as a PreToolUse/BeforeTool handler on the completion curl — the handler writes `.stride-changed-files.json` automatically. stride-opencode is a TypeScript plugin using the `@opencode-ai/plugin` interface, so this release ports the same capture function into TypeScript and wires it into the plugin's `tool.execute.before` / `tool.execute.after` lifecycle. The wire shape, the encoding contract, and the inline-cat-in-jq read pattern in the SKILL.md are byte-identical to the other plugins; only the implementation language differs.

### Backward compatibility

The wire shape of `changed_files` is unchanged. Completion payloads that omit it continue to validate (the empty-array form produced by the inline `|| echo '[]'` fallback is also valid). Reviewers consuming the field now see uncommitted edits and untracked-new files inline in `/review` whereas prior versions had no capture at all.

### Source

Mirrors stride 1.15.0 (G157/W758) into stride-opencode. Delivered in opencode as W738. The `captureChangedFiles` TypeScript implementation is a faithful semantic port of the canonical bash `capture_changed_files()` — same `git diff $base` working-tree semantic, same untracked-new-file synthesis, same binary detection paths, same 500-line truncation rule, same `[binary file — no diff captured]` placeholder. No marketplace coordination — stride-opencode ships by tag directly.

## [1.8.0] - 2026-05-19

### Changed

- **`agents/task-reviewer.md`** — Rewrote Step 6 ("Return Structured Review") and the Output persistence paragraph to require an unconditional fenced ```json block alongside the existing markdown prose. The block matches the canonical `reviewer_result` schema documented in [`stride/agents/task-reviewer.md`](https://github.com/cheezy/stride/blob/main/agents/task-reviewer.md) — `schema_version`, `summary`, `status`, `issue_counts`, `issues[]` (with `severity`/`category` enums), and `acceptance_criteria[]` (with `met`/`not_met` enum). Includes a verbatim worked `changes_requested` example. The prose summary line is preserved above the JSON block so orchestrator fallback paths that grep substring summaries continue to work when JSON parsing fails. No opencode-specific schema variant introduced — the canonical schema is cited by path.
- **`skills/stride-subagent-workflow/SKILL.md`** — Added an "Extracting the structured review block" subsection to Phase 3 (Code Review). The orchestrator now extracts the first fenced ```json fence from the reviewer's response and populates `reviewer_result` in the completion PATCH payload with both (a) the legacy summary fields (`summary`, `issues_found` from `sum(issue_counts.values())`, `acceptance_criteria_checked` from the length of the structured array) and (b) the structured fields verbatim (`status`, `issue_counts`, `issues`, `acceptance_criteria`, `schema_version`). Includes a worked example and a documented fallback path that keeps older agent versions and parse failures working: substring-match the prose summary, omit structured fields from the PATCH (never empty placeholders), do not abort the completion.
- **`package.json`** — Version bumped from `1.7.0` to `1.8.0`.

### Source

Ported from stride 1.13.0 (commits 9c19359 "Define structured JSON review-report schema in task-reviewer agent" and 8e94eca "Extract structured review block into reviewer_result PATCH payload"). Cross-plugin parity for Stride W685/W686 (implemented in stride-opencode as W698).

## [1.7.0] - 2026-05-08

### Removed

- **`skills/stride-workflow/SKILL.md`** — Removed all three references to the user-private `stride-development-guidelines` skill: the Step 5 ("Activate Development Guidelines") section, the corresponding flowchart node, and the Quick Reference Card line. That skill is project-local to the plugin author's machine and is not distributed with this plugin, so end users would have seen Step 5 instructing them to activate a skill that does not exist for them. The Step 5 slot is left empty rather than renumbered to avoid breaking step-number cross-references elsewhere in the file.

### Changed

- **`package.json`** — Bumped version from 1.6.0 to 1.7.0.

### Why this release

Cross-skill references to non-plugin skills break the workflow for end users. This guard rail is being applied to all five Stride plugins (`stride`, `stride-codex`, `stride-gemini`, `stride-opencode`, `stride-pi`) in a coordinated release.

## [1.6.0] - 2026-05-06

### Added

- **`agents/task-enricher.md`** — New custom agent that owns the four-phase enrichment procedure (intent parse, codebase exploration, complexity heuristic, 16-item validation checklist). Receives sparse task fields from the orchestrator and returns a single enriched-task JSON object ready for `PATCH /api/tasks/:id`. Ported from stride 1.11.0 (`stride/agents/task-enricher.md`) with OpenCode-specific frontmatter (no `name:` field — inferred from filename; `mode: subagent`; `temperature: 0.2`; `tools:` as a map of booleans `read: true, grep: true, glob: true, bash: false, edit: false, write: false`). The body is platform-neutral with `grep`/`glob`/`read` invocation syntax matching the existing OpenCode agents.

### Changed

- **`skills/stride-enriching-tasks/SKILL.md`** — Slimmed from 784 lines to 268 lines. The four-phase manual enrichment procedure now lives in `agents/task-enricher.md`. The skill retains the STOP preamble, MANDATORY warning, API Authorization block, Iron Law, API integration curl examples, and output example, but the OpenCode path now invokes `task-enricher` instead of walking the procedure inline. Other environments still follow the condensed manual walkthrough phases (Phases 1-4 retained in summary form, with the 16-item Phase 4 checklist preserved verbatim). The OpenCode-specific frontmatter fields (`license: MIT`, `compatibility: opencode`, `metadata.category`, `metadata.version`) are preserved untouched.
- **`skills/stride-subagent-workflow/SKILL.md`** — Added `task-enricher` to the agent inventory in the MANDATORY teaser block. Added a new `## Pre-Claim: Enrichment (Sparse Tasks)` section documenting when and how to invoke the enricher before claiming a task. Added `task-enricher` to the Quick Reference Card and References section. Updated the frontmatter `description:` to enumerate `task-enricher` alongside the other custom agents. OpenCode-specific frontmatter fields preserved.
- **`skills/stride-workflow/SKILL.md`** — Step 1 enrichment check expanded into two platform subsections: `#### OpenCode: Invoke the Enricher Agent` (3-step invoke + PATCH flow) and `#### Other Environments: Activate the Enrichment Skill` (manual-phase fallback). Matches the stride 1.11.0 platform-split pattern.
- **`package.json`** — Version bumped from `1.5.0` to `1.6.0`.

### Source

Ported from stride 1.11.0 (commit 92b72ea). Cross-plugin parity goal G86 / W351.

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
