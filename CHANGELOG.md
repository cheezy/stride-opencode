# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.13.0] - 2026-06-06

Parity release bringing the OpenCode plugin in line with canonical stride G210, which adds `security_considerations` as the **fifth** review_queue-scored field (alongside `acceptance_criteria`, `testing_strategy`, `pitfalls`, `patterns_to_follow`). Feature minor. All five content-bearing skill/agent files now treat `security_considerations` as a first-class scored deliverable, and the reviewer emits a fifth section verdict at `schema_version` **1.3**.

### Added

- **`skills/stride-creating-goals/SKILL.md` + `skills/stride-creating-tasks/SKILL.md` — `security_considerations` as the 5th scored field (W1039).** Adds `security_considerations` to the review_queue-scoring banner, the required/nesting field lists, the minimum-bar list, the Red Flags, the Rationalization Table, and the example JSON in both creation skills; creating-tasks also gains the `### security_considerations` Embedded-Object-Formats subsection (array-of-strings shape + the `"None — …"` escape hatch). OpenCode port wording (frontmatter, ✅/❌ emoji labels, the "NESTED TASKS ARE NOT EXEMPT" banner heading) preserved.
- **`skills/stride-enriching-tasks/SKILL.md` + `agents/task-enricher.md` — security pass + 17-item checklist (W1040).** Step 5 now covers security analysis (input validation, authorization boundaries, secret handling, injection surfaces, data exposure) producing `security_considerations`; the pre-submission checklist grows 16 → 17 items; `security_considerations` is added to the PATCH/output example JSON, the field-type reminders, and the Red Flags.
- **`agents/task-decomposer.md` + `agents/task-reviewer.md` — decomposer Required field + reviewer security verdict (W1041).** task-decomposer marks `security_considerations` Required in the field table, the output template, and every worked-example task. task-reviewer adds the Step 5 "Security Considerations Alignment" review step (steps renumbered), the `security_considerations` section verdict object, the `"security"` issue category, the expanded consistency rule, and bumps the reviewer `schema_version` **1.2 → 1.3**.
- **`skills/stride-completing-tasks/SKILL.md` + `skills/stride-workflow/SKILL.md` — persist & extract the security verdict (W1042).** The `reviewer_result` structured block in completing-tasks lists the `security_considerations` section verdict (and bumps its example to schema 1.3); stride-workflow Step 6 copies `security_considerations` verbatim in the field map and the fallback omit-list, and its worked example carries the security verdict at `schema_version` 1.3.

### Changed

- **Manifest/docs reflect the fifth scored field (W1043).** `AGENTS.md` and `README.md` updated to describe the reviewer's `schema_version` 1.3 block with the `security_considerations` per-section verdict and to name `security_considerations` as the fifth review_queue-scored field. Version bumped 1.12.0 → 1.13.0 in `package.json`.

### Backward compatibility

Documentation/contract additions only. Older completions that omit `security_considerations` (or send the thin `reviewer_result` envelope / self-reported-skip form) continue to validate — the server tolerates the absent structured key. No plugin hook routing, parser contract, env-var matrix, or `.stride.md` change is required. The version bump affects discovery metadata only. All intentional OpenCode adaptations (TypeScript plugin hook execution, self-reported-skip primary path, JavaScript extraction pattern, `read`/`grep`/`glob` tool vocabulary, `.opencode/` install destinations, AGENTS.md context file) are preserved.

### Source

G210 (canonical) / W1039 (creation skills), W1040 (enrichment skill + enricher agent), W1041 (decomposer + reviewer agents), W1042 (completing-tasks + workflow skills), W1043 (release). Mirrors the canonical stride G210 `security_considerations` fifth-scored-field rollout into the OpenCode variant. No marketplace pin update — stride-opencode is not distributed through stride-marketplace.

## [1.12.0] - 2026-06-05

Parity update bringing the OpenCode plugin in line with canonical stride 1.18.0 → 1.20.0: the reviewer's structured `reviewer_result` schema (project checks + section verdicts, schema 1.2), verbatim structured-result persistence, the D54 `changed_files` credential-resolution fix, the two context-informed creation commands and their threading docs, and a behavior-preserving hardening pass on the TypeScript plugin.

### Added

- **`agents/task-reviewer.md`** (W968, W969) — Reviewer schema advanced 1.0 → **1.2**. Adds **project-level checks** (read `CODE-REVIEW.md`, evaluate each top-level bullet, `CRITICAL:` prefix → critical severity, emit `project_checks[]` with a paired `issues[]` entry for every `not_met`; mirrors stride **1.18.0**) and the per-section **`testing_strategy` / `patterns` / `pitfalls` verdict objects** (`passed | failed | not_assessed`) with the failed↔matching-category-issue consistency rule (mirrors stride **1.19.0** / D58).
- **`skills/stride-completing-tasks/SKILL.md`** + **`skills/stride-workflow/SKILL.md`** (W970) — Document persisting the reviewer's **full structured JSON block verbatim** as `reviewer_result` (merged with the legacy summary fields), plus the Step 6 "Extracting the structured review block" extraction + field-mapping + JSON-parse-failure fallback. Mirrors stride **1.19.0** / D57. The schema stays owned by `agents/task-reviewer.md`.
- **`commands/create-tasks.md`** + **`commands/create-goals.md`** (W973) — Two native OpenCode commands (`/create-tasks`, `/create-goals`) that load a `--dir` (alias `--context`) directory of project markdown as a read-only context bundle and route through `stride-workflow`, which dispatches the creation sub-skills (never invoked directly). Mirrors stride **1.20.0**'s `/stride:create-tasks` / `/stride:create-goals`. `commands/` added to `package.json` `files`; install path `.opencode/commands/`.
- **`skills/stride-workflow/SKILL.md`**, **`skills/stride-creating-tasks/SKILL.md`**, **`skills/stride-creating-goals/SKILL.md`** (W972) — Context-threading docs: the "Context-Informed Creation (Command Entry Points)" section and the "Consuming Provided Context" field-mapping sections (augment-never-override; the four review_queue fields and the `"goals"` root-key / index-dependency rules stay required). Mirrors stride **1.20.0**.
- **`agents/hook-diagnostician.md`**, **`agents/task-decomposer.md`** (W974) — Reconciliation: ported the missing "Input Detection and Parsing" section (structured-JSON-from-the-plugin vs raw-text) and the worked "Example: Goal Decomposed into Tasks".

### Fixed

- **`src/capture.ts`** + **`src/index.ts`** + **`src/capture.test.ts`** (W971) — **D54 `changed_files` credential resolution.** New `resolveStrideApiUrl` / `resolveStrideApiToken` read `$projectDir/.stride_auth.md` as the primary source — the production `**API Token:**` line, deliberately **not** the `**Local API Token:**` line — falling back to the intercepted-command literals, so the upload works even when the completion curl used `$STRIDE_API_URL` / `$STRIDE_API_TOKEN` shell variables. Fire-and-forget / non-fatal; the token is never logged. +7 tests (127 → 134). Mirrors stride **1.19.0** / D54.

### Changed

- **`src/index.ts`**, **`src/capture.ts`**, **`src/index.test.ts`** (W967) — Behavior-preserving hardening pass on the TypeScript plugin: removed the sole production `any` (typed the shell helper structurally), extracted and unit-tested the previously-duplicated `tool.execute` payload accessors (`extractCommand` / `extractToolName` / `extractToolArgs`), and tightened `extractEnvFromResponse` typing. No observable behavior change. +14 tests (113 → 127); `tsc --noEmit` clean.
- **`skills/stride-subagent-workflow/SKILL.md`**, **`skills/stride-workflow/SKILL.md`** (W974) — Reconciliation: removed a stale `schema_version: "1.0"` reviewer-extraction example from `stride-subagent-workflow` (extraction is owned by `stride-workflow` Step 6); dropped an internal task-identifier from the after_goal hooks note and aligned its no-op wording with canonical.

### Backward compatibility

Additive. The reviewer's legacy summary fields (`summary`, `issues_found`, `acceptance_criteria_checked`) are preserved alongside the new structured keys; the server tolerates the structured keys and renders only what it receives. The TypeScript hardening is behavior-preserving (every existing test still passes). The D54 resolver adds `.stride_auth.md` as a *primary* credential source while keeping the command-literal extraction as a fallback, so existing completions keep uploading. No `.stride.md`, `.stride_auth.md`, or `.gitignore` changes are required; `bun install` and re-copy the skills, agents, and the new `commands/` directory into your `.opencode/` paths. No marketplace pin update — stride-opencode is not distributed through stride-marketplace.

### Source

G206 / W967–W975. Feature minor mirroring the canonical stride **1.18.0** (project checks), **1.19.0** (D54 changed_files credential resolution, D57 structured reviewer_result persistence, D58 section verdicts), and **1.20.0** (context-informed creation commands + threading docs) releases, plus a TypeScript hardening pass (W967) and a full accuracy reconciliation of the ported skills/agents against canonical (W974).

## [1.11.1] - 2026-05-25

### Changed

- **`skills/stride-creating-tasks/SKILL.md`** (W861) — Adds a top-of-file "⚠️ REVIEW QUEUE SCORING" callout that names the four fields the review_queue dashboard scores on every completion (`acceptance_criteria`, `testing_strategy`, `pitfalls`, `patterns_to_follow`) and frames the consequence of omitting any of them: a visible, public, persistent **empty pill** on the dashboard that does not get back-filled later. Reinforces with four new bullets in the existing **Red Flags - STOP** list and four new rows in the existing **Rationalization Table**. Wording matches the stride/ Claude Code variant for cross-plugin consistency.
- **`skills/stride-enriching-tasks/SKILL.md`** (W862) — Adds a top-of-file "⚠️ REVIEW QUEUE SCORING — ENRICHMENT IS THE LAST CHANCE" callout. Promotes the four scored fields to individual mandatory-for-review items in the Phase 4 16-item pre-submission checklist (replacing the prior single-line bundling), each with its specific empty-pill condition. Adds four new Red Flags - STOP bullets.
- **`skills/stride-creating-goals/SKILL.md`** (W863) — Adds a top-of-file "⚠️ REVIEW QUEUE SCORING — NESTED TASKS ARE NOT EXEMPT" callout stressing the four-field minimum bar applies to every nested task individually — no "it's just a subtask" discount. Strengthens Task Nesting Rules with a per-field block enumerating each scored field with its empty-pill condition. Adds four new Red Flags - STOP bullets and four new Rationalization Table rows.

### Backward compatibility

Content-only release. No hook script, parser contract, env-var matrix, API field shape, or workflow step changed — every behavior is byte-identical to 1.11.0. The three SKILL.md edits strengthen guidance only; existing task-creation, enrichment, and goal-creation calls continue to validate without modification. No `.stride.md`, `.stride_auth.md`, or `.gitignore` changes are required.

### Source

G166 / W861 / W862 / W863 / W864. Patch release — documentation-only emphasis updates across three SKILL.md files. The change set mirrors the stride/ plugin's 1.17.3 release (Claude Code variant) and the goal is to raise the floor on the four fields the review_queue dashboard scores at completion, so empty pills become rare rather than common.

## [1.11.0] - 2026-05-25

### Critical fix

- **`src/capture.ts`** and **`src/index.ts`** — `finalizeAfterDoing` now PUTs the per-file diff snapshot to Stride immediately after writing `.stride-changed-files.json` to disk, with the body wrapped as `{"changed_files": [...]}` (G162 + G174 ports from main stride 1.16.0 + 1.17.2 shipped together). URL and Bearer token are extracted from the intercepted agent completion command using the same regex shape as the bash hook — no new env vars, no `.stride_auth.md` read. The PUT uses Bun's native `fetch` inside a try/catch that swallows network and 4xx/5xx errors — `after_doing` remains blocking-but-not-fragile. Silently no-ops when any prerequisite is missing (no apiBase, no token, no `TASK_ID`). The on-disk snapshot is preserved unchanged so legacy `--argjson cf` consumers on older deployments still read it. **G162 and G174 ship together because the wrap is required for the PUT to work at all** — a bare top-level array lands at `params['_json']` under Plug.Parsers, validates as `{:ok, nil}`, and is persisted as NULL, silently clearing `changed_files`.

### Added

- **`src/capture.ts`** — Three new exports: `extractApiBase`, `extractToken`, and `putChangedFiles`. Regex constants `API_BASE_RE = /https?:\/\/[A-Za-z0-9._-]+(?::[0-9]+)?/` and `TOKEN_RE = /Bearer +([A-Za-z0-9._+/=-]+)/` match the bash hook's `grep -oE` shape so a /complete curl is the single source of truth for both transport layers. `putChangedFiles(apiBase, token, taskId, files)` strips trailing slashes from `apiBase`, builds `${apiBase}/api/tasks/${taskId}/changed_files`, and PUTs the wrapped body via `fetch`. All four early-return paths (null apiBase / null token / null taskId / fetch throw) degrade silently.
- **`src/capture.test.ts`** — 17 new tests in 2 describe blocks. `extractApiBase / extractToken` (7 cases: https URL, http+port URL, empty-command nulls, missing-URL null, Bearer extraction, missing-Bearer null, allowed special characters). `putChangedFiles` (10 cases: wrapped-body PUT round-trip with method/URL/headers/wire-shape assertions, empty-snapshot wraps as `{"changed_files":[]}` not bare array, trailing-slash strip, three null-input no-ops, fetch-error swallow). Suite total: 113 pass / 0 fail (96 prior + 17 new).

### Backward compatibility

The wire-shape fix is fully backward-compatible at the server boundary. The on-disk `.stride-changed-files.json` snapshot is preserved unchanged so legacy `--argjson cf` consumers on older deployments still read it. Against pre-1.16.0 Stride servers without the `PUT /api/tasks/:id/changed_files` endpoint, the hook PUT 404s harmlessly (fire-and-forget) and the inline-cat pattern in `stride-completing-tasks/SKILL.md` remains the path that carries the snapshot.

### Migration

`bun install` your updated stride-opencode plugin. No `.stride.md`, `.stride_auth.md`, or `.gitignore` changes required. No marketplace pin update — stride-opencode is not distributed through stride-marketplace.

### Source

G162 (auto-PUT — implementation W846) + G174 (wrapped body — folded into W846 since shipping the PUT without the wrap is the broken state that made stride 1.17.2 a critical fix). Mirrors the stride/ 1.16.0 + 1.17.2 releases and stride-pi/extensions/hook-bridge/changed-files.ts:180-215 (canonical TypeScript reference pattern).

## [1.10.0] - 2026-05-22

### Added

- **`## after_goal` hook section** — fifth `.stride.md` hook, fires after the parent goal's final child task completes. Blocking, same single-bash-fence parsing rule as the four existing hooks. The plugin's `src/index.ts` `tool.execute.after` handler now inspects the response payload of `/complete` and `/mark_reviewed` for an `after_goal` entry and executes the local `## after_goal` section as a blocking hook when present. Missing section is a clean no-op (back-compat). Structured failure JSON surfaces on stdout for the agent to forward via `PATCH /api/tasks/:goal_id/after_goal` per the Stride server contract. Implemented as W793.
- **`responseHasAfterGoal(output: unknown): boolean`** — new exported pure function in `src/index.ts`. Handles the three transport shapes the existing `extractEnvFromResponse` handles (string output, `.output`/`.result` peel, Bash-tool `{stdout: "<json>"}` wrapper) plus an edge case where `output` is a raw object with `.hooks` at top level. Returns `true` when the payload's `hooks` array contains an entry with `name === "after_goal"`.
- **`GOAL_*` env vars** — `GOAL_ID`, `GOAL_IDENTIFIER`, `GOAL_TITLE`, `GOAL_DESCRIPTION` forwarded into the `## after_goal` child process environment, sourced verbatim from the server-supplied `hook.env`. `BOARD_*`, `COLUMN_*`, `AGENT_NAME`, and `HOOK_NAME` remain present across all five hooks.
- **`skills/stride-workflow/SKILL.md`** (W795) — Step 7 (Execute Hooks) opens with a Hooks Reference table listing all five hooks (timing/blocking/timeout/purpose), followed by a Hook Environment Variables matrix (`TASK_*` vs `GOAL_*` per hook) and a Canonical Hook Examples block. Step 9 (Post-Completion Decision) gains a subsection describing the goal-Done transition triggered by `after_goal` success and the agent's `PATCH /api/tasks/:goal_id/after_goal` POST contract. Examples explicitly note the hook is general-purpose (Slack notifications, artifact archival, release pipelines, project-level smoke tests are all valid uses).
- **`AGENTS.md`** (W795) — Hook Execution section extended to mention the five recognized sections (including `## after_goal`) with a cross-reference to SKILL.md Step 7+9.
- **`src/index.test.ts`** (W794) — 12 new tests in a `describe("responseHasAfterGoal", ...)` block covering: wrapped Bash-tool payload, raw API JSON payload, absent after_goal, empty hooks array, missing hooks key, malformed outer JSON, malformed inner stdout JSON (falls back cleanly), null/undefined input, object output with `.output`/`.result` wrappers, raw object output with `.hooks` at top level, and defensive non-object entries in the hooks array. Suite total: 99/99 pass, 166 expect() calls.

### Backward compatibility

A `.stride.md` without a `## after_goal` section continues to work unchanged. The four existing hook routes produce behaviorally identical output (empirically confirmed by all 87 pre-existing tests passing unchanged after the `tool.execute.after` control-flow refactor). Older agent runtimes that don't speak the after_goal protocol — including those that don't make the PATCH POST — are covered by the server-side grace-window worker.

One intentional semantic improvement: when `## after_review` is empty AND the server emits an `after_goal` entry, the after-goal block now fires (pre-v1.10.0 the empty-`after_review` early-return would have missed the after_goal payload).

### Migration

`bun add opencode-stride@1.10.0` (or your normal opencode plugin install flow). No `.stride.md`, `.stride_auth.md`, or `.gitignore` changes are required. To opt into the new hook, add a `## after_goal` section to `.stride.md`. The receiving Stride server must include the `PATCH /api/tasks/:id/after_goal` endpoint and the `after_goal_status` / `after_goal_result` / `after_goal_attempts` columns for agent reports to land.

### Source

G165 / W793 (TypeScript routing in src/index.ts), W794 (12-test responseHasAfterGoal coverage in src/index.test.ts), W795 (SKILL.md + AGENTS.md), W796 (this release). Pattern mirrors the Claude plugin's v1.17.1 release.

## [1.9.1] - 2026-05-21

### Fixed

- **`skills/stride-completing-tasks/SKILL.md`** — Replaced three occurrences of `"$CLAUDE_PROJECT_DIR/.stride-changed-files.json"` with the defaulted form `"${CLAUDE_PROJECT_DIR:-.}/.stride-changed-files.json"` in the canonical inline-cat pattern. The inline structure, the `--argjson cf "$(cat ... 2>/dev/null || echo '[]')"` shape, and the binary/truncation contract are unchanged — only the variable expansion is defaulted.

### Why this release

Under runtimes where `$CLAUDE_PROJECT_DIR` is unset/empty (notably Claude Code's TypeScript SDK when bridging from OpenCode), the bare expansion produced `/.stride-changed-files.json`. The `cat` failed, the `|| echo '[]'` fallback fired, and agents POSTed `changed_files: []` even when the hook had correctly written the snapshot. The defaulted form `${CLAUDE_PROJECT_DIR:-.}` falls back to the current working directory when the variable is unset or empty.

### Backward compatibility

Wire shape unchanged. Behavior under a non-empty `$CLAUDE_PROJECT_DIR` is byte-identical to v1.9.0.

### Source

Mirrors the stride v1.15.1 fix (W767/W768) for the OpenCode variant. Implemented as W773 (SKILL.md hotfix) and W774 (release coordination). No marketplace pin update — stride-opencode is not distributed through stride-marketplace; consumers install directly from this repository.

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
