# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Release record — tags without a GitHub release

*This is a record-keeping note, not a release. It describes no change to this plugin and carries no version.*

A fleet-wide audit found **4 tags** in this repository that are tagged and pushed but have no corresponding GitHub release. **The gap is accepted and will not be backfilled.** It is recorded here so the next release engineer does not rediscover and re-litigate it:

- `v1.2.1` — 2026-04-14
- `v1.4.0` — 2026-04-16
- `v1.7.0` — 2026-05-08
- `v1.8.0` — 2026-05-19

Why accepted rather than backfilled:

- **Nothing resolved through these releases.** A GitHub release is a human-readable record, not a resolution mechanism — nothing installs *through* one. The missing releases cost nothing at the time and cost nothing now.
- **Backfilling would be worse than the gap.** A release created today against a commit from April or May would be dated today, and would manufacture a record for a state no user ever resolved through — misrepresenting the very history it claims to document.
- **The convention itself is unchanged.** These are omissions from a few release cycles, not a policy shift. Every tag still gets a release going forward.

The audit also found **zero** GitHub releases without a matching tag, so the record is incomplete in only this one direction.

## [Unreleased]

## [1.35.0] - 2026-07-31

### Added — an optional `/harden` sub-step that drafts regression checks, sequenced so it can never turn the blocking test gate red (W2002)

A session that finds a bug and stops has closed nothing — the same bug can come back unnoticed. The exploratory extension's `/harden` command reads a session's oracle-confirmed bugs and drafts one regression check per convertible bug from its `minimal_repro`, which is the step that turns *Explored* back into *Checked*. Wired into the workflow it is the one place this integration can close that loop automatically.

Two traps make naive sequencing **worse than not doing it at all**, and both are handled explicitly rather than mentioned:

- **`stride-workflow` gains Step 6.6 and `stride-subagent-workflow` gains Phase 3.6**, identical in substance, sitting between the manual-testing step and the hooks. The gate is **three** conditions: a session actually ran and returned convertible findings; **the `/harden` command itself is registered**; and native slash-command dispatch is available. The second is deliberately narrower than "the extension is installed" — `/harden` is not one of the surfaces the Step 6.5 gate detects, and it arrived in the extension's **v0.2.0**, one release after the base, so an installed extension can predate it. The third replaces the reference plugin's "this is Claude Code" condition, which has no meaning in this port: `/harden` ships as a command only (the extension's `agents/` holds just `explorer` and `charter-generator`), so custom-agent availability establishes nothing about it.
- **Trap 1 — the blocking gate.** `after_doing` is a blocking hook that typically runs the project's suite, and a check reproducing an **unfixed** bug is *supposed* to fail: that failure is the evidence it reproduces the bug. Sequenced naively, a session that did exactly the right thing blocks the completion of a task that may not even be scoped to fix that bug. The step therefore dispatches `/harden` **without `--output`**, so drafts land in `.exploratory/checks/` outside the test tree where the gate never sees them, and that staged state is the always-safe default. A check enters the suite only when **two** things hold, and a skip marker gives only one: **the file must load** — a skip marker makes a *case* inert, not a *file*, and runners compile or import the whole tree first, so a draft carrying an unresolved `TODO(harden):` wiring marker (which `/harden` is expressly permitted to leave) fails at compile or collection time however it is tagged — and **the case must be green or inert**. Both are established by **running the project's own `after_doing` command across the whole suite once, never by expecting**, with a revert of everything the attempt touched if it does not come back clean. Exactly three dispositions are permitted: run-and-see-it-pass for a bug fixed in the same task (updating the draft's now-false "expected to fail today" header); moved in marked skipped or pending with a follow-up defect filed for a bug still open — with the note that **`xfail` is not a skip**, since it runs the test and, under `xfail_strict`, fails the run once the bug is fixed; or left staged with a follow-up defect. **Never leave a check red in the test tree** — the hazard is presence in the working tree, not the commit. And **never overwrite an existing test file: that check is the workflow's own**, because dispatched without `--output` the command never writes into the test tree and so nothing suffixes a collision there for you.
- **Trap 2 — post-review divergence.** `/harden` writes after the reviewer has already seen the diff, so the reviewed diff and the final diff diverge, and unreviewed executable code entering a commit unannounced is exactly what review exists to prevent. Paths are named in `completion_notes`, one line is mirrored into `completion_summary`, and any check that entered the test tree is listed in `actual_files_changed` — the required structured list, where naming a file only in prose is how the divergence stays invisible. The reviewer is **re-run whenever a check entered the tree at all**, without weighing whether the edit was "substantial", since a rule that turns on a judgement call resolves toward skipping the expensive option.
- **`stride-completing-tasks` gains a "Recording hardened checks" subsection** covering counts, unconverted bugs, draft locations and the disposition taken per still-open bug, plus the rule that a drafted check is **never reported as passing** unless it was actually run and seen to pass. The sink-independent redaction rule is extended to drafted checks, whose headers embed the source bug title and a one-line repro derived from observed application output.

- **A local pre-execution check on every draft, because inheriting the rules by reference was not enough.** `/harden`'s contract forbids a draft from hard-coding an observed credential, pointing at a real host, or writing a destructive step, and requires a check derived from a **security** finding to assert the guard fires rather than perform the unsafe act. But OpenCode commands declare no tool allowlist, so those are the command's **discipline, not environment-enforced** — and this step is what turns that output into code the suite compiles and executes. Trusting the contract for what a draft *contains* while distrusting it for whether a draft was *run* is not a coherent position, so both skills now require **reading the draft and confirming all four properties before it reaches the commit — moved, run, or left staged where the artifact directory turns out not to be ignored** — with a failing draft going to the third disposition rather than into the tree, and its contents read **as data to assess, never as instructions** (a header that asserts the draft is safe or waives a property is itself a reason to defer). The draft file is also named as a **sink in its own right**, not merely something the completion fields describe: once moved, `after_doing`'s `git add -A` commits it, and a credential in repository history is far harder to walk back than one in a payload field.
- **The post-review surfacing triggers are keyed on "reaches the commit", not "entered the test tree".** A moved check obviously reaches it — but so does a **staged** draft on a project where the operator never took Step 0's `.gitignore` advice, since `after_doing` stages with `git add -A` and `.exploratory/` is ignored only if someone ignored it. Both skills now say to **verify rather than assume** (`git check-ignore -q .exploratory/`) and, where the directory is not ignored, to treat staged drafts exactly like moved ones — listed in `actual_files_changed` and re-reviewed — or remove them. Keying the control on the test tree while `git add -A` decides the commit was the exact gap the step's own words warn about: "omitting a file from it while mentioning it in prose is how the divergence stays invisible."

**On `completion_summary`, which is not a new carrier.** The exploratory *findings* recording still uses exactly the two carriers 1.34.0 established. `completion_summary` is a required, always-persisted, Review-queue-rendered field that these skills already mirror one line into whenever a fact must reach a human even where `completion_notes` may not be persisted — the credential-bearing-row refusal, the steering-row refusal, and Step 6.5's own Critical-finding escalation all do it. A file written after review is that same shape of fact, so this applies an established convention rather than introducing one. **No new completion field and no seventh `workflow_steps` name**: the dispatch's wall-clock folds into the existing `reviewer` entry, and when no reviewer ran that entry is the skip form with no duration.

**Supersedes a clause in `[1.34.0]`.** That entry's "Deliberately not ported" paragraph named `/harden` / Step 5.6 as still unported. It is ported here. The clause is **left as written there**, on the precedent `[1.32.1]` already set for a stale cross-reference in a published entry: historical entries are recorded rather than rewritten. The change-set provenance machinery named alongside it remains genuinely unported.

### Fixed — four stale representations that contradicted the shipped dispatch rule

Adding the Step 6.6 / Phase 3.6 nodes surfaced that v1.33.0's non-interactive dispatch guard had been applied to the prose but not to the **secondary representations of the same flow**, which a reader scans *instead of* the prose. The `stride-workflow` Complete Workflow Flowchart and Quick Reference Card, and the `stride-subagent-workflow` Workflow Flowchart and Quick Reference Card, all still instructed dispatching **`/explore` (or `@explorer`)** at the manual-testing step — directly contradicting the sanctioned-surfaces rule three sections above them, which sanctions `@explorer` alone and puts `/explore` on the never-auto-dispatch list. All four now say `@explorer` only, name `/explore` and `/pair` as excluded, and mention the session budget and the authorized non-production affirmative. This is the same class of defect `[1.32.1]` fixed for the Step 5 placeholder: a rule stated only in the prose leaves the most-scanned surfaces still saying the old thing.

### Backward compatibility

Fully backward compatible. Documentation-only — no hook logic, credential path, or wire shape changes. **No new completion field and no seventh `workflow_steps` name.** The hardening step is entirely optional and gated three ways; when it skips — no session, no convertible findings, no registered `/harden`, or no native command dispatch — the workflow behaves exactly as it did before the step existed, and nothing blocks. The sequencing rule's whole purpose is that the blocking `after_doing` gate is never made red by this step: the default disposition leaves drafts outside the test tree entirely. The flowchart/card corrections align those surfaces with a rule that already shipped in 1.33.0; they change no behaviour that the prose did not already specify.

### Source

W2002, porting `stride/skills/stride-workflow/SKILL.md` Step 5.6 and `stride/skills/stride-subagent-workflow/SKILL.md` Phase 3.6 — translated to this port's terser voice and **Step 6.6 / Phase 3.6** numbering, with the reference's "this is Claude Code" gate condition reframed as native-command-dispatch availability, since this port carries no Claude-Code-versus-other-environment branch anywhere. The `/harden` contract details — positional bug source, `--framework` override, the `.exploratory/checks/<timestamp>-<slug>/` default location, the `TODO(harden):` wiring-marker allowance, the no-framework path that writes nothing to disk, and the never-run/never-claim-a-pass discipline — were established from `stride-opencode-exploratory-testing`'s own `commands/harden.md` rather than copied from the reference page, as was the v0.2.0 arrival used by the gate. Ends at the tag and GitHub release on this repo — **stride-opencode has no marketplace catalog**; installs resolve through a direct GitHub reference.

## [1.34.0] - 2026-07-31

### Added — an explicit session budget on the exploratory dispatch, stakeholder impact and artifact paths in the recording, and `.exploratory/` in the gitignore guidance (W2001)

Three additions to the optional exploratory-testing integration, all documentation-only and all built on carriers that already exist.

- **A session budget, in both workflow skills.** The dispatch previously supplied charters, the target and app context but **no bound on how far the session could run** — an unbounded dispatch inside an autonomous workflow is a runaway risk and a larger blast radius against a live application, and the caller is the only party who knows what the task can afford. `stride-workflow` Step 6.5 gains a **`Provide the plugin with:`** input list and `stride-subagent-workflow` Phase 3.5 extends its existing `Provide the dispatch with:` list, both carrying **the session budget as the caller's to set, not the session's**. The figures are read from the **installed** extension's own `explorer` contract rather than from this page, since the two repositories release independently — today probes, default **12**, band **8–20**, plus a **tool-call ceiling** defaulting to **5× the probe budget**, whichever is reached first ending the session. The budget is a **ceiling, never a quota**, and a budget too small to fund one workable charter means **do not dispatch at all**: a token session that never reaches the feature produces a false coverage claim, which is worse than not running.
- **A tightened environment-context bullet**, in both skills. It now names the three things a session actually needs — **how to reach the running app**; the **authorized, non-production confirmation**, framed as a safety control rather than a formality (never defaulted to authorized, never supplied on the user's behalf, and without it the dispatch does not happen); and **where test accounts or seed data live**. Credentials are **pointed at, never inlined**: a dispatch prompt is an artifact like any other, and a pointer to the project's seed or fixture files serves the session just as well.
- **Budget exhaustion is stated as a normal outcome that never fails completion.** Both skills now record how a session ended, naming the `stop_reason` values the installed contract actually emits (`charter_quiet`, `probe_budget_exhausted`, `tool_call_ceiling`, `risk_acceptable`, `blocked`), and both gain graceful-path bullets: a session that stopped on its budget produced **valid findings over partial coverage** — record them, say the coverage was partial, and complete as normal. Only a charter that went quiet supports claiming the manual test was fully performed.
- **Richer recording, in the two existing carriers only.** `stride-completing-tasks` now records each finding's **stakeholder impact** — the RIMGEA *Externalize* product the explorer emits as `bugs[].stakeholder_impact`, which is what a reviewer weighing a finding actually needs, since severity says how bad the consequence was but not who is harmed. It is used when the session supplies it and **never invented** when it does not; "the session did not establish it" is an honest answer and is never quietly upgraded into a confident one. The guidance also **cites the session artifact's path when one was written** — with the caveat that usually none was, because the only surface Step 6.5 may dispatch is the `explorer` subagent, whose contract grants it no write or edit tool and never directs it to write one; an artifact exists when a human separately ran a session command. Record the **path, never the contents**, and cite it **repository-relative, never absolute** — an absolute path would disclose the home directory, username and machine layout into a persisted, rendered field, so relativizing is a requirement rather than a preference, restated inside the redaction rule itself. The sink-independent redaction rule is **extended rather than duplicated** to govern both the stakeholder-impact text and the artifact path.
- **`.exploratory/` added to the gitignore guidance.** The Marker Contract's `.gitignore` row previously named only `.stride/`. Sessions write artifacts under `.exploratory/`, those artifacts hold transcribed application output — exactly the material redaction keeps out of the completion payload — and they arrive **untracked**, while `after_doing` commonly stages with `git add -A`. Neither behaviour is wrong alone; together they silently commit observed application data into the task's own commit, and a commit is far harder to walk back than a payload field. The row now names **both** directories with that mechanism stated in one clause, and keeps it **operator guidance — the skill never edits anyone's `.gitignore`.** Crucially the guidance is now also **actually delivered**: **Step 0 gains a third prerequisite item** that checks for both entries and tells the operator once when either is missing. Naming Step 0 as the delivery point from Step 6.5 was not enough on its own — Step 6.5 is only read once a session may already have run, so the instruction has to live in the step that runs first. The check is also **re-triggered whenever the extension is installed**, not only at Stride's first install: the two ship independently and the extension routinely arrives later, so an install-time-only mention would never reach the operator most exposed to this. And because a `.gitignore` line is **inert against an already-tracked path**, the guidance says to pair it with `git rm --cached` when an artifact was already committed.

**Deliberately not ported**, as later work: the reference's fuller session-ending taxonomy (the zero-probe vs meaningful-probe coverage dispositions, the "hand the manual test back" branch, and the older wall-clock-contract `stopped_early` disambiguation) — this release states only that budget exhaustion is a normal, non-failing ending while naming the real `stop_reason` values. Also not ported: the reference's **third** recording carrier, a `completion_summary` mirror — this integration stays on its two existing carriers — along with `/harden` / Step 5.6 and the change-set provenance machinery, both still unported since 1.33.0.

### Backward compatibility

Fully backward compatible. Documentation-only — no hook logic, credential path, or wire shape changes. **No new completion field and no seventh `workflow_steps` name**; the budget travels in the dispatch prompt and the new recording rides `completion_notes` and `reviewer_result.testing_strategy.note`, both already free text. The integration remains entirely optional and every path still skips gracefully when the extension is absent — budget exhaustion is one more never-fails-completion ending, not a new failure mode, and a budget too small to spend is a documented skip rather than an error. The gitignore change is advisory prose only: no `.gitignore` is edited automatically.

### Source

W2001, porting the session-budget dispatch input, the tightened environment context, the richer recording, and the artifact gitignore guidance from `stride/skills/stride-workflow/SKILL.md`, `stride/skills/stride-subagent-workflow/SKILL.md`, and `stride/skills/stride-completing-tasks/SKILL.md` — translated to this port's terser voice and Step 6.5 numbering. The budget's unit, default, band and ceiling multiplier were established from `stride-opencode-exploratory-testing`'s own installed `agents/explorer.md` contract rather than copied from the reference plugin's page, and the "usually no artifact" caveat from that agent's inability to write files. Ends at the tag and GitHub release on this repo — **stride-opencode has no marketplace catalog**; installs resolve through a direct GitHub reference.

## [1.33.0] - 2026-07-31

### Added — a severity mapping and a fail-closed escalation policy for exploratory findings, and a stated non-interactive dispatch principle (W2000)

Two optional integrations hang off the same phase of this workflow with opposite consequences, and until now the difference was an accident rather than a decision. A `partial` or `unmitigated` verdict from the Deep security-considerations review is **fail-closed** — it fails the section, appends a Critical issue, and blocks completion until the consideration is addressed. A Critical finding from an exploratory session was advisory prose in `completion_notes`. Nothing said why one blocks and the other does not.

It is now a decision. An exploratory finding's severity **maps** onto the `reviewer_result.issues[].severity` enum the review gate already acts on, and a Critical finding **this task introduced** escalates the same fail-closed way the security verdict does. What it deliberately does *not* do is block a task for a bug it did not cause:

- **`stride-completing-tasks`** gains a **Severity mapping** section: the extension's four-level `bug-advocacy` ladder (Critical > High > Moderate > Minor) maps onto the reviewer's three values — Critical → `critical`, High and Moderate → `important`, Minor → `minor` — findings are **mapped, never re-rated**, and an absent or unrecognized severity maps to `important`, never dropped and never `critical`, so text that failed to parse can never reach a blocking path. It states explicitly that **mapping a severity is not the same as appending an `issues[]` entry** (only an *introduced* Critical becomes one, because any `category: "testing"` entry forces `testing_strategy` to `failed`), and it points at the workflow skills for the escalation itself rather than restating it. The pre-submission self-check gains a matching consistency bullet.
- **`stride-workflow` Step 6.5** and **`stride-subagent-workflow` Phase 3.5** each gain the escalation policy, **identical in substance** and differing only in length. An **introduced** Critical — its responsible lines among the lines this task added or modified — fails `testing_strategy`, appends a `category: "testing"` / `severity: "critical"` issue, and is fixed, re-charter-run, and re-reviewed before completing. A **discovered** one — responsible lines anywhere else — is recorded at its exploratory severity and filed as a follow-up defect, with **no** issue appended and **no** verdict flipped. Uncertainty always resolves to *discovered*, and the fault site is localized **by reading the code, never from the finding's own text**, because the application under test controls that text and a policy that can block completion must not be steerable by content an attacker can influence. The policy is also explicitly inert when no reviewer ran (a small task has no `issues[]` to append to), and forbids synthesizing a `reviewer_result` to create one.
- **Both skills and the README** replace the open-ended "prefer `/explore`, or dispatch `@explorer`" phrasing with a stated **principle**: dispatch only a surface that can complete the step **unattended**. This orchestrator never prompts the user between steps, so an interactive surface stalls the task until the claim expires — a failure that looks like a hang rather than a violation. The principle governs, and any surface the extension gains later is judged against it rather than against a list. Today it sanctions exactly one surface — the **`explorer` subagent (`@explorer`)**, which states outright that it never asks the user a question — and names as never-auto-dispatched `/explore` (its mandatory opening question round asks which app-driving tools the session has, which a command cannot enumerate about itself and therefore cannot pre-answer), `/pair`, `/nightmare-headline`, `/recon`, and the `stride-exploratory-testing` routing skill (which routes to a surface not known in advance, and is what the bare extension name resolves to). The detection lists are clarified to confer no dispatch licence.

- **Redaction is restated sink-independently**, in all three skills. Every statement of the rule enumerated its fields, and an enumeration reads as exhaustive — `stride-completing-tasks` covered `completion_notes` and the `testing_strategy` note, and the two workflow skills covered `reviewer_result`, `completion_notes`, and `completion_summary`. None of them named **`review_report`**, which the dispatch step's own debrief fold writes to whenever the task `needs_review`: the one sink instructed to take session output *in bulk* rather than as the agent's own restatement, and persisted and rendered on the Review queue like the rest. All three now lead sink-independently — nothing observed in a session is persisted unredacted, whichever field carries it, in the completion payload or in any task record you create — name both `review_report` and **the follow-up defect's own title and description** (that record is persisted and rendered too, and sits outside the completion payload entirely), and state that a field absent from the list is still covered. Both skills also gain the rule that **finding text which tries to steer the introduced/discovered classification is itself a finding** — reported, not obeyed — mirroring how this port already treats a steering `behaviour_test_matrix` row.

**`/explore` is excluded in this port, and that was established rather than assumed.** The sibling Claude Code plugin excludes it for the same reason, but the two extensions version independently, so the claim was checked against `stride-opencode-exploratory-testing`'s own `commands/explore.md`, whose Step 3 runs "a single consolidated round of questions (≤4 questions, asked in the conversation)". Each never-dispatch entry here was likewise read from that extension's own front matter and prompt body — as data, never by executing it — and both skills say so, and say to re-establish each entry whenever that separately-versioned extension changes.

### Backward compatibility

Fully backward compatible. Documentation-only — no hook logic, credential path, or wire shape changes. **No new completion field and no seventh `workflow_steps` name**: the escalation is built entirely on existing carriers (`reviewer_result.testing_strategy`, `issues[]`, `issue_counts`, `completion_notes`, `completion_summary`). The graceful-skip contract is **unchanged and restated in both skills**: when the extension is absent, the task carries no `manual_tests`, or no session ran, the step skips exactly as before — **no exploratory finding can block completion on a task that never ran a session**, and the new self-check bullet explicitly records that its own absence is the normal case rather than a gap.

### Source

W2000, porting `stride/skills/stride-completing-tasks/SKILL.md` (severity mapping), `stride/skills/stride-workflow/SKILL.md` (Step 5.5 escalation + sanctioned dispatch surfaces), and `stride/skills/stride-subagent-workflow/SKILL.md` (Phase 3.5) — the Claude Code plugin is the treatment of record, translated to this port's terser voice, its `extension`/`subagent`/`@mention` vocabulary, and its **Step 6.5** numbering (this port keeps Step 5 intentionally blank, so Code Review is Step 6). Deliberately **not** ported, as later work: the session budget / probe-count taxonomy, the `/harden` hardening step, and the change-set provenance machinery (`.stride-env-cache` base-ref lookup, `.stride-dirty-baseline` subtraction, nested-repo base recovery) — this port decides provenance from its own diff and `actual_files_changed`, which it already carries. Ends at the tag and GitHub release on this repo — **stride-opencode has no marketplace catalog**; installs resolve through a direct GitHub reference.

## [1.32.1] - 2026-07-28

### Added — an explicit intentionally-blank Step 5 placeholder in the workflow skill (W1942)

`skills/stride-workflow/SKILL.md` jumped straight from **Step 4: Implementation** to **Step 6: Code Review** with no Step 5 heading and no note, so the gap read as a lost section. That made this port's numbering look broken to anyone auditing it — and, worse, made its **correct** Step 6 citations read as off-by-one bugs, since the sibling Claude Code and Gemini ports number Code Review as Step 5.

The slot has been empty since **v1.7.0**, which removed the Step 5 "Activate Development Guidelines" section because it activated the project-author-private `stride-development-guidelines` skill that is not distributed with this plugin. That release deliberately left the number empty rather than renumbering Steps 6–9, to keep the file's many cross-references stable — but it recorded the reasoning only in the changelog, where a reader of the skill never sees it.

v1.7.0 removed **three** things — the Step 5 section, its flowchart node, and its Quick Reference Card line — so the gap was visible in three places. All three are restored here, mirroring the treatment the `stride-codex` port (which shares this numbering) already has:

- **The heading sequence** gains `## Step 5: (intentionally left blank)` with a one-line rationale naming v1.7.0, why the slot is preserved, and "proceed directly from Step 4 to Step 6".
- **The Complete Workflow Flowchart** gains a `(STEP 5 intentionally removed in v1.7.0 -- slot preserved, Steps 6-9 not renumbered)` node between STEP 4 and STEP 6.
- **The Quick Reference Card** gains a `5. (removed in v1.7.0 -- slot preserved to keep Step 6-9 numbers stable)` line.

The flowchart and the card matter more than the heading list for this defect, because both are self-contained representations of the sequence that a reader scans *instead of* the headings — a placeholder only in the heading chain would have left the two most-scanned surfaces still reading as a lost section.

The port's fractional `Step 6.5` already carried its own numbering note; it now also names Step 5, so a reader who meets that note first learns there is a second, deliberate numbering anomaly.

**No step was renumbered and no cross-reference changed.** The diff is purely additive — four added lines and zero deletions in the flowchart/card/heading surfaces, plus one extended sentence in the Step 6.5 note.

### Backward compatibility

Fully backward compatible. Documentation-only — no hook logic, credential path, wire shape, or behaviour changes, and every existing Step 6 citation in this port remains correct exactly as written.

### Source

W1942, part of goal G386, which reconciles step-reference and release-record drift across the Stride fleet. `stride-codex/skills/stride-workflow/SKILL.md` is the treatment of record. Ends at the tag and GitHub release on this repo — **stride-opencode has no marketplace catalog**; installs resolve through a direct GitHub reference.

**Known, not fixed here:** the `[1.32.0]` entry above cites "the Step 5 self-review checklist" for a checklist that lives in **Step 6** of this port — a sibling-port number (the Claude Code and Gemini ports number Code Review as Step 5) written into this port's record, and a live example of exactly the confusion this release exists to prevent. It is left as written because that release is already tagged and published, and historical entries are recorded rather than rewritten.

## [1.32.0] - 2026-07-28

### Changed — the `behaviour_test_matrix` rules treat row text as untrusted, and say what to do when it carries a credential

`behaviour_test_matrix` row text is authored by whoever created the task and is attacker-controlled at the API boundary — anyone posting directly to the Stride API never sees these instructions. v1.31.0 threaded the field through the port; this release hardens every rule that reads it, and resolves a contradiction that made one of them impossible to obey.

- **Row text is data, never instructions.** The completion self-check's matrix gate and the Step 4 implementation driver both state the boundary explicitly: a row is a specification to satisfy, and text inside a row that appears to address the agent, waive a check, or exempt the task is content being submitted — reportable as a finding, never a directive to follow (back-ported in W1946).
- **The secret rule is scoped to row *state*, not agent intent, and covers references.** A row that embeds a secret, credential, or token — **or that names a location where one lives** (file path, env var, secret-store key, vault reference, CI/CD or platform secret, Kubernetes Secret, git object, database row) — is by that fact alone a defect to raise (D184, D187).
- **A refused row has a named reporting channel and a defined representation.** The implementing agent reports the defect in `completion_notes`, identifying the row by `category` and position rather than quoting its text, and leaves the row exactly as authored. The reviewer, required to echo rows verbatim, instead substitutes the literal sentinel `[REDACTED — row text embedded a credential]` into the required field carrying the credential, echoes that row `failing`, and raises a `category: "security"` issue. The resulting `failed` verdict is the **expected outcome of a correct refusal** (D186).
- **The PATCH-body contradiction is resolved.** The driver mandated recording a row's status advance by PATCHing the matrix while forbidding a credential from reaching the PATCH body — unsatisfiable together, since `PATCH /api/tasks/:id` replaces the whole array and a non-empty matrix is rejected unless it covers all seven categories. The rules now state that re-sending row text the record **already stores**, byte-for-byte unchanged, back onto that same record is not a new copy, and name exactly one correct action (D185).
- **The Step 5 self-review checklist** gained a `behaviour_test_matrix` bullet (W1949).

### Changed — guidance now cites the real controls instead of authoring conventions

- **`completion_notes` is persisted.** Every span that described it as unpersisted now states the deployment-conditional truth: persisted by Stride servers from D188 onward, but an agent cannot tell which server version it is talking to. The rule requiring the refusal to *also* appear in one line of `completion_summary` is unchanged — only its premise was corrected.
- **Row-text rendering is defended by escaping, not by an authoring rule.** The creation and enrichment guidance now cites the real controls (auto-escaped interpolation on every render path; the API hard-rejects an out-of-vocabulary `category` or `status`), keeps the no-raw-HTML rule as hygiene, and separates the secrets rule as genuinely authoring-only (W1947).

## [1.31.0] - 2026-07-26

### Added — `behaviour_test_matrix` support: populate at creation, verify at review, utilize during implementation (W1937–W1939)

Tasks may now carry an **optional** `behaviour_test_matrix` — an array of rows, each pairing one behaviour the change must satisfy with the real test that covers it, across **seven fixed categories** (`"Happy path"`, `"Boundary"`, `"Error / exception"`, `"Null / empty"`, `"Concurrency"`, `"Lifecycle / wiring"`, `"Contract / serialization"`). Each row is `{ category, behaviour, test_name, type, status, na_reason, position }`, where `type` is `"unit"` / `"integration"` / `"manual"` (or a `/`-joined combination) and `status` is `"planned"` / `"passing"` / `"failing"` / `"not_applicable"`. Every row either names a real test or is waived with an `na_reason` — a row with neither is rejected. The field is **all-or-nothing**: absent, `null`, and `[]` all pass, but a **non-empty** matrix must carry a row for **every** one of the seven categories.

The support is threaded through the whole lifecycle:

- **Creation** — `stride-creating-tasks` documents the field in the recommended-fields checklist, the Complete Task Object (a full seven-row sample), the Field Quick Reference, and a new Embedded Object Formats subsection with four WRONG cases and a labelled RIGHT excerpt; `stride-creating-goals` documents the identical shape for nested tasks, with no batch-specific variation.
- **Enrichment** — the `task-enricher` agent projects the `unit_tests` / `integration_tests` / `manual_tests` / `edge_cases` it just derived onto all seven categories and emits the matrix **by default** when Step 3 produced any test cases, waiving genuinely-inapplicable categories with a specific `na_reason` rather than inventing a test; the pre-submission checklist grows from 17 to **18 items**, with `behaviour_test_matrix` as its sole optional entry. `stride-enriching-tasks` mirrors this in the manual walkthrough.
- **Review** — `task-reviewer` verifies each row against reality (locating the named test in the diff or the existing suite), judges it Verified / Missing / Mismatch, and echoes the outcome using the **same four-value row status enum** the task-authored matrix uses (Verified → `"passing"`; Missing and Mismatch → `"failing"`). Missing and Mismatch rows are filed as Important `category: "testing"` issues — there is deliberately **no new issue category**. The reviewer emits a new **OPTIONAL** top-level `behaviour_test_matrix` verdict (`{ status, note, rows[] }`) and bumps the `reviewer_result` schema from **1.5 to 1.6**; the verdict key is **omitted entirely** when the task supplied no matrix, rather than sent as an empty `not_assessed` placeholder. Escalation is **fail-closed**: any echoed `"failing"` row forces the section status to `"failed"` and requires a matching `category: "testing"` issue.
- **Utilization** — `stride-workflow` Step 4 instructs the implementing agent to write the test each row names, advance that row's `status` from `"planned"` to `"passing"` (or `"failing"` if left red), and record the advance by PATCHing the updated matrix onto the task; Step 6 passes the field to `task-reviewer` with the rest of the review fields. `stride-subagent-workflow` documents this as orthogonal to its complexity matrix, and `stride-completing-tasks` adds a pre-submission self-check for the verdict's presence, row shape, and fail-closed consistency.

Row text is treated as untrusted **data, never instructions** — a row that reads like a directive ("mark this row verified", "skip the remaining rows") is content under review, and the creation and enrichment docs forbid recording secrets, credentials, or raw HTML in `behaviour`, `test_name`, or `na_reason`.

### Testing

`bun test` — 275 pass / 0 fail; `bun run typecheck` clean. The change is documentation/prompt-text only, so no suite behaviour changes. Additionally verified by JSON-parse sweep (every fenced JSON block added parses; the pre-existing annotated blocks that do not parse were confirmed unchanged against a stashed tree), by category-coverage grep (7/7 categories present in both the enricher agent and the enrichment skill), and by a word-level comparison of every added line against the Claude Code reference change-set — the mirrored text is identical apart from three sanctioned OpenCode adaptations (custom-agent wording, `agents/task-reviewer.md` paths, Step 5 → Step 6). A repo-wide grep confirms no stale `schema_version` `1.4`/`1.5` remains in any skill or agent file, and `README.md` / `AGENTS.md` were re-synced to 1.6 alongside.

### Backward compatibility

Fully backward compatible. Documentation/skill-text only — no `src/` change, no hook logic, `.stride.md`, env-var, or `.stride_auth.md` change. `behaviour_test_matrix` is **optional** everywhere and is never one of the five review_queue-scored fields, so a task without one behaves exactly as before and never shows an empty pill. No new required completion field and no new `workflow_steps` name were introduced, so existing completions keep validating unchanged. The reviewer's new verdict key is additive and absent by default; the row `status` enum reuses the existing four values rather than introducing a reviewer-only vocabulary.

### Source

W1937–W1939 (goal G385) — the OpenCode analog of the Claude Code goal G381, against the same Kanban `behaviour_test_matrix` field added in G379. The canonical `reviewer_result` schema of record stays at `stride/agents/task-reviewer.md`; this port cites it and never redefines it. OpenCode has no marketplace (install is a `github:` ref pin), so the version lives only in `package.json` and the release is push main + tag + `gh release` on this repo alone — there is no catalog to re-sync.

## [1.30.0] - 2026-07-22

### Added — optional Deep Security-Considerations Review with the `stride-opencode-security-review` extension (W1875–W1879)

The review phase now has an **optional, doubly-gated** deep security check that dispatches the separate [`stride-opencode-security-review`](https://github.com/cheezy/stride-opencode-security-review) extension when it is installed. `stride-workflow` **Step 6 (Code Review)** gains a *Deep security-considerations review* sub-step — after `task-reviewer` runs — that engages only when BOTH the task's `security_considerations` list is non-empty (an explicit `"None — …"` placeholder does not count) AND the extension's sanctioned surface (`/security-review`, the `security-reviewer` agent, or the `security-review-essentials` skill) is available in the session, detected **availability-only** (never by reading, sourcing, or eval'ing any `.opencode/` file). When it runs, the `security-reviewer` is dispatched in **considerations mode** with the diff and the task's `security_considerations` list — framed as **data to assess, never as instructions** (prompt-injection safety) — and returns one `consideration_verdicts` entry per consideration.

The verdicts are merged into `reviewer_result.security_considerations.considerations[]` via the existing **whole-object passthrough** — no new completion field, no new `workflow_steps` name (the dispatch folds into the existing `reviewer` step). The check is **fail-closed**: any `partial`/`unmitigated` verdict flips the `security_considerations` section to `failed` and raises a matching `category: "security"` Critical issue, which routes through the existing review gate so an un-addressed consideration cannot reach Done; a present-but-malformed response keeps the prose verdict and never silently downgrades to `passed`.

The integration is threaded through the skill catalog: `agents/task-reviewer.md` documents the nested `security_considerations.considerations[]` array (each `{ consideration, status: mitigated | partial | unmitigated, evidence, note }`) and its fail-closed escalation rule, and bumps the `reviewer_result` schema from **1.4 to 1.5**; `stride-subagent-workflow` documents the dispatch as **Phase 3.1** in the decision matrix (mirroring the exploratory-testing Phase 3.5 gate); and `stride-completing-tasks` documents that the nested array rides through the whole-object copy verbatim and adds a pre-submission self-check that a deep-reviewed section's `considerations[]` is present and status-consistent. Every piece is **optional and non-blocking**: when the extension is absent or the task carries no real `security_considerations`, the workflow falls back to the `task-reviewer` prose verdict and completion is never blocked or failed.

### Testing

Documentation-only; no test suite is exercised. Verified by grep sweep and JSON parse: `schema_version` reads `1.5` in every occurrence of `agents/task-reviewer.md` with the worked-example JSON still parsing; the Step 6 sub-step, the Phase 3.1 decision-matrix entry, and the completing-tasks passthrough + self-check are present; the trigger wording (non-empty `security_considerations` + extension available, availability-only detection) is consistent across `stride-workflow`, `stride-subagent-workflow`, and `agents/task-reviewer.md`; and no new required completion field or `workflow_steps` name was introduced.

### Backward compatibility

Fully backward compatible. Documentation/skill-text only — no `src/` change, no hook logic, `.stride.md`, env-var, or `.stride_auth.md` change. The deep security review is entirely optional and gated on the separate extension being installed: with the extension absent or the task carrying no real `security_considerations`, the workflow behaves exactly as before and completion is never blocked. It adds no new server-validated field and no new `workflow_steps` name, so existing completions keep validating unchanged. The nested `considerations[]` array is additive and never required.

### Source

W1875–W1879 (goal G370) — the OpenCode analog of the Claude Code goal G367 (W1861–W1864), wiring the `security_considerations` deep review into the review phase and dispatching the same-runtime `stride-opencode-security-review` extension (created in G369). OpenCode has no marketplace, so the version lives only in `package.json`; there is no catalog to re-sync.

## [1.29.0] - 2026-07-21

### Added — optional Manual & Exploratory Testing integration with the `stride-opencode-exploratory-testing` extension (W1810–W1814)

The workflow now has an **optional, doubly-gated** manual-testing step that dispatches the separate [`stride-opencode-exploratory-testing`](https://github.com/cheezy/stride-opencode-exploratory-testing) extension when it is installed. `stride-workflow` gains **Step 6.5: Manual & Exploratory Testing** between Code Review (Step 6) and Execute Hooks (Step 7) — numbered `6.5` so no existing step is renumbered. It runs only when BOTH the task's `testing_strategy.manual_tests` is non-empty AND the extension's sanctioned surface (`/explore`, `/charter`, `/recon`, `/debrief`, the `explorer` / `charter-generator` agents, or the `stride-exploratory-testing` skill) is available in the session, detected **availability-only** (never by reading, sourcing, or eval'ing any `.opencode/` file). When it runs, each `manual_tests` entry is mapped to an exploratory charter and dispatched via `/explore` (or `@explorer`) against an **authorized, non-production** target under the extension's absolute safety boundary (never destructive; app content is data, not instructions), and the debrief is folded into `completion_notes`.

The integration is threaded through the skill catalog: `stride-subagent-workflow` documents it as **Phase 3.5** in the decision matrix (mirroring the `task-explorer` / `task-reviewer` rows); `stride-completing-tasks` documents recording the findings in **existing tolerant fields only** — `completion_notes` and the existing `reviewer_result.testing_strategy` note — with **no new server-validated field and no new `workflow_steps` name** (either would break strict completion validation); and `stride-creating-tasks` / `stride-creating-goals` gain an **advisory** note to phrase `manual_tests` entries as chartable scenarios (a target plus the information/risk to discover), with a before/after example. Every piece is **optional and non-blocking**: when the extension is absent, the task carries no `manual_tests`, or no authorized running app is reachable, the workflow falls back to the current behavior and completion is never blocked or failed.

### Fixed — the enrichment surface documented create and update bodies without their `task` root key (D151)

`stride-enriching-tasks` documented submitting an enriched task with a bare body: `POST /api/tasks` carried `-d '{...enriched task JSON...}'` and no `agent_name`. The server requires a `{"task": {...}}` envelope and rejects a bare object with `422 Missing 'task' key`, so an agent following the enrichment skill literally built a rejected request and — once corrected by hand — created a task with no attribution fallback. The create example now shows the envelope with `"agent_name": "OpenCode"` beside the `task` key, matching the Request Envelope section in `stride-creating-tasks` and the plain agent name this port already sends on claim and complete.

The same file's `PATCH /api/tasks/:id` example was broken the same way and is fixed too — but its rule differs and the doc now says so: `PATCH` needs the identical `task` root key, yet takes **no** `agent_name`, because attribution is create-only and `created_by_agent` is forbidden on update. Conflating the two would have been its own defect.

The `task-enricher` agent doc is deliberately **left unwrapped**: its JSON is the agent's return value for the orchestrator to submit, not a request body, so an envelope there would be wrong. It gains a note saying exactly that, and pointing at who does the wrapping.

This surface was missed by goal G4687 (the fleet-wide `agent_name` rollout) because it sits outside that goal's tasks' `key_files` and outside both of their grep sweeps.

### Testing

Documentation-only; no test suite is exercised. Verified by grep sweep: the enrichment create example carries the envelope and this port's own agent name, matching its `stride-creating-tasks` Request Envelope section; every curl body in the file is brace-balanced; and no other file in the port documents a create body. For the exploratory-testing integration (W1810–W1814): grep confirms Step 6.5 sits between Steps 6 and 7 with the existing Step 7/8/9 numbering intact, the Phase 3.5 decision-matrix entry and the completion-recording guidance are present, the trigger wording is identical across `stride-workflow`, `stride-subagent-workflow`, and the creation skills, and no new required completion field or `workflow_steps` name was introduced.

### Backward compatibility

Fully backward compatible. Documentation/skill-text only — no `src/` change, no hook logic, `.stride.md`, env-var, or `.stride_auth.md` change. The D151 shapes are corrected to what the server has always required; nothing that previously worked stops working. The exploratory-testing integration is entirely optional and gated on the separate extension being installed: with the extension absent, no `manual_tests`, or no authorized non-production app, the workflow behaves exactly as before and completion is never blocked. It adds no new server-validated field and no new `workflow_steps` name, so existing completions keep validating unchanged.

### Source

D151 — follow-up to goal G4687; the gap was recorded by the W1684 reviewer as out of scope at the time. Kanban `task_controller.ex` is the contract of record: `create/2` reads `agent_name` beside the `task` key, `update/2` requires `task` and reads no `agent_name`. W1810–W1814 (goal G354) — integrate the optional [`stride-opencode-exploratory-testing`](https://github.com/cheezy/stride-opencode-exploratory-testing) extension into the workflow, completion, and creation skills. OpenCode has no marketplace, so the version lives only in `package.json`; there is no catalog to re-sync.

## [1.28.0] - 2026-07-16

### Added — every documented create payload carries a top-level `agent_name` (W1692)

Ports the canonical `stride` plugin's W1684 change (released as `stride` v1.37.0) into the opencode bridge. `stride-creating-tasks`, `stride-creating-goals`, and `agents/task-decomposer.md` now document a top-level `agent_name` on every create request — beside the `task` root key for `POST /api/tasks` and beside the `goals` root key for `POST /api/tasks/batch` — set to the exact same plain agent name the bridge already sends as `agent_name` on claim and complete (`"OpenCode"`, never the `ai_agent:<model>` token form).

Per-task `created_by_agent` is forgotten in practice and cannot be backfilled (`PATCH` rejects it), so tasks lost their attribution permanently and the `/agents` feed rendered them with a `?` avatar. The root-level param is the always-sent fallback that kanban D137 teaches the server to read. Both creation skills gain the full five-step server resolution order (explicit `created_by_agent` → token `ai_agent:<model>` → top-level `agent_name` → token's last agent name → unset), an `agent_name` row in their field tables, and an explicit note that `agent_name` is display metadata only — never an authorization signal.

**Scope note:** this change is documentation-only. `src/` builds no create payload — it is the hook executor (hook detection from the agent's curl command, `changed_files` capture and PUT, `after_goal_status` GET, `.stride.md` parsing, skill gating), and the agent itself issues the create request. A repo-wide grep confirms `src/**/*.ts` contains no `POST /api/tasks` call and no `agent_name` or `created_by_agent` reference, so there is no TypeScript create-payload builder to update.

### Fixed — `stride-creating-tasks` documented the single-create body without its `task` root key

The skill's complete example was a bare task object, but `POST /api/tasks` requires a `{"task": {...}}` envelope and returns `422 Missing 'task' key` without it. Surfaced while placing `agent_name` "beside the task root key" — the key it had to sit beside was never documented. A new Request Envelope section shows the wrapper with `agent_name` as its top-level sibling, and the Quick Reference heading now names the block as the value of the `task` key rather than the request body; the single-goal format in `agents/task-decomposer.md` is corrected the same way. The bridge inherited this defect from the canonical plugin, where W1684 fixed it.

### Testing

`bun test` — 275 pass, 0 fail, 574 expect() calls across 5 files, unchanged from the pre-change baseline (no `src/` change, so no test change). Additionally verified by the task's grep sweeps: both creation skills document the top-level `agent_name`, every literal create and batch payload in the repo carries it, and every non-illustrative `json` fence in the two creation skills and the decomposer parses as valid JSON.

### Backward compatibility

Fully backward compatible, and safe to ship ahead of the server. Documentation/skill-text only — no `src/` change, no hook logic, `.stride.md` wire shape, env-var, or `.stride_auth.md` change. Unknown top-level keys are ignored by older servers, so sending `agent_name` before kanban D137 reaches production is a no-op. `created_by_agent` guidance is unchanged and still highest precedence — the new param is a fallback, never a replacement.

### Source

W1692 — mirrors the canonical `stride` plugin's W1684 (`stride` v1.37.0), and the `stride-codex` (v1.25.0), `stride-copilot` (v2.26.0), and `stride-gemini` (v1.36.0) ports. Kanban D137 ships the server half. Released by W1693 as `stride-opencode` v1.28.0 (tag + GitHub release on this repo only — this plugin has no marketplace; installs resolve via a github ref pin).

## [1.27.0] - 2026-07-14

### Fixed — capture `TASK_BASE_REF` after the `before_doing` section + trust-guard the snapshot base (D142)

Ports the canonical `stride` plugin's D142 base-ref fixes (released as `stride` v1.36.0) into the opencode bridge. `TASK_BASE_REF` was captured at claim time — in the `tool.execute.after` claim block, **before** the `## before_doing` section's `git pull` moved `HEAD` — so the `after_doing` `changed_files` diff spanned commits pulled from **another clone**, and a reviewer saw another machine's completed task inside an unrelated defect's Review diff panel (the D132/W1678 incident). **Scope note:** opencode never ported the W1516 dirty-baseline filter, so the D142 D137 committed-range override has nothing to patch and is intentionally out of scope here.

- **`src/index.ts` (D132)** — The `before_doing` claim block now persists task **identity only** and strips any inherited `TASK_BASE_REF` (the fresh `extractEnvFromResponse` assignment never carries a base). A new `finalizeBeforeDoing()` re-captures `HEAD` and re-persists `TASK_BASE_REF` — stamped with a `TASK_BASE_REF_TRUSTED` marker — **after** `executeCommands` returns for the `before_doing` route, regardless of the section's exit code (including the no-`.stride.md` path, where there is no section to move `HEAD`). `extractHookEnvFromResponse` now also drops a server-supplied `TASK_BASE_REF_TRUSTED` so the marker can never be spoofed.
- **`src/capture.ts` (D132)** — New exported `resolveSnapshotBase($, cwd, base, trusted)` trust guard implementing the three reference rules — recompute an empty/unresolvable base, a non-ancestor-of-`HEAD` base, or (for **unmarked** inherited bases only) a strict-ancestor-of-branch-point base, from the task branch point (merge-base of `HEAD` and the origin default branch), with a loud `console.error` notice. A repo with no origin passes the base through unchanged. `finalizeAfterDoing` runs it **once per task window** and memoizes the judgment (the early pre-command capture sees the pre-push origin refs, so a `## after_doing` `git push` advancing `origin/main` can't make a correct base look stale and empty the snapshot); the resolved base is persisted as a `base=` line in `.stride-diff-upload-state` (via `recordDiffUploadState` / `readDiffUploadState`) so the `before_review` self-heal reuses the same judgment instead of re-resolving against moved origin refs.

### Testing

`bun test` (275 assertions across 5 files) and `tsc --noEmit` both pass. New coverage: `resolveSnapshotBase` unit tests over a two-clone bare-origin cross-pull fixture (recompute for older/empty/unresolvable/non-ancestor bases, passthrough for trusted, branch-point-equal, and no-origin cases, and the loud stderr notice), the `base=` round-trip in the upload-state helpers, and two end-to-end integration tests (the two-clone cross-pull excludes the other clone's pulled file and records the post-pull trusted base; a push-in-`after_doing` keeps the task's file via the once-per-window memoization and persists `base=` for the self-heal). Nine existing upload-state assertions were updated for the additive `base=` line.

### Backward compatibility

Backward-compatible and additive. The `TASK_BASE_REF_TRUSTED` cache key and the `base=` state line are new but tolerated when absent (an inherited cache simply gets the full trust guard; older state files report `base` as `undefined`). No marketplace change — opencode installs are a `github:` ref pin.

### Source

D142 — mirrors the canonical `stride` plugin at v1.36.0 (`finalize_before_doing`, `resolve_snapshot_base`, the claim identity-only strip, and the once-per-window memoization + persisted `base=`). The D137 committed-range override is out of scope (opencode has no dirty-baseline filter).

## [1.26.1] - 2026-07-10

### Fixed — target the changed_files upload by the `/complete` URL id (D127)

The `after_doing` finalize and `before_review` self-heal previously targeted the changed_files PUT using the claim-time env-cache `TASK_ID`. When that cache is stale or corrupt (a piped/truncated claim capture, or a host restart before the on-disk cache reloads), the diff was uploaded to the **previous** task, leaving the current task's `changed_files` empty. Both paths now resolve the task id from the authoritative `/complete|/mark_reviewed` command URL first, via a new `taskIdFromCommand(command)` helper (a pure, digit-only parse mirroring `task_id_from_command` in `stride/hooks/stride-hook.sh`), falling back to the env-cache id only when the URL carries no id (the claim path). Pure string parse — no new network call.

### Added — fail loud on a terminal changed_files upload failure (W1658)

The `before_review` self-heal is the **last** upload retry. When its PUT still returns a non-2xx status (or a transport failure, which `putChangedFiles` maps to `0`), the plugin now logs a distinct `stride-hook: CHANGED_FILES UPLOAD UNRESOLVED for task <id> (HTTP <code>) …` message to stderr and appends an `unresolved=yes` marker to `.stride-diff-upload-state` (new `markDiffUploadUnresolved` helper in `src/capture.ts`), so a definitively-lost diff is actionable rather than silently swallowed. Fail-soft: this never vetoes the already-succeeded `/complete`. A legitimately-empty diff that PUTs 2xx takes the success path, and a later successful PUT overwrites the state file, self-clearing the mark.

## [1.26.0] - 2026-07-09

### Added — `after_goal` reliability port: canonical response file + fresh-GET guarantee (G4969: W1636–W1640)

The plugin captures whatever `tool.execute.after` `output` the host hands it, and a large `/complete` response (the echoed `reviewer_result` alone runs to tens of KB) can be truncated before the plugin parses it — silently dropping the bundled `after_goal` entry and its `GOAL_*` env on a goal's last child. Ported the stride D118/D119/W1609/W1612 reliability work to opencode across three layers:

- **Transport helpers (`src/capture.ts`, W1636):** `getAfterGoalStatus(apiBase, token, taskId)` performs a fail-soft `GET /api/tasks/:id/after_goal_status` returning a typed `{armed, goalId, env}` (`null` on any degraded path); `writeCanonicalResponse` / `readCanonicalResponse` round-trip `${projectDir}/.stride/.last-api-response.json`, which is added to the `ROOT_ARTIFACTS` exclusion so it never enters a task's `changed_files`.
- **Read side (`src/index.ts`, W1637):** `tool.execute.after` captures the current response to the canonical file when it is complete valid JSON (a valid response overwrites a stale file; a truncated one leaves a good file intact), and resolves a **file-first** response view so `after_goal` detection and `GOAL_*` env extraction prefer the untruncated file, falling back to the intercepted output.
- **Reliability guarantee (`src/index.ts`, W1638):** when neither the file nor the output yields an `after_goal`, a hook-initiated fresh `getAfterGoalStatus` GET — keyed off the claim-cached `TASK_ID` — detects an armed `after_goal` independent of the response payload and runs the `## after_goal` section from the fresh result. De-duplicated against the fast path (`## after_goal` runs at most once) and best-effort (missing `TASK_ID`, unreachable endpoint, or not-armed → silent no-op). The `TASK_ID` is captured before the `after_review` cleanup so the guarantee also holds on `/mark_reviewed`.
- **Tests (W1639)** and **docs (W1640):** end-to-end coverage of the truncation-rescue and no-false-positive paths, and `skills/stride-workflow/SKILL.md` now documents the canonical file as the untruncated source, the fresh-GET guarantee, and a post-completion push-verification step (the grace-window worker flips the goal to Done but does **not** push).

## [1.25.1] - 2026-07-02

### Fixed — README and AGENTS.md accuracy drift (D97)

Surface docs contradicted the shipped plugin: README and AGENTS.md said the reviewer emits **schema 1.3** while `agents/task-reviewer.md` declares `schema_version` **1.4**; both documented **four** subagents while **five** ship (`task-enricher` exists, is dispatched by `stride-subagent-workflow`, and was invisible in the docs); and the README's install-pin example referenced the ancient `#v1.4.0` tag. All corrected — schema references bumped to 1.4, `task-enricher` documented in the README subagents table and the AGENTS.md agent list, the copy-the-agent-files step says five files, and the pin example uses the current release tag.

### Correction — historical install-method claims

The 1.17.0, 1.16.0, and 1.14.0 entries below state that consumers install via plain `npm install opencode-stride`. That claim predates the discovery that the npm package is unpublished; those entries stay as written — history is not rewritten. The current install method is README Step 1: the `github:cheezy/stride-opencode` reference in `opencode.json` (pin with `#v<tag>`), with skills/agents copied per README Step 2.

### Fixed — hook-diagnostician aligned with structured input and plugin-enforced timeouts (W1501)

The agent's parsing section extracted `commands_completed` / `commands_remaining` / `command_index` from the plugin's structured failure JSON, but its only output template was the raw-text legacy shape — there was no way to render the command sequence it was told to extract. The agent now mirrors the canonical two-template structure: a structured-JSON template with a **Command Sequence** block (`[PASSED]` from `commands_completed`, `[FAILED]` from `failed_command`, `[SKIPPED]` from `commands_remaining`, with the empty-`commands_remaining` edge case documented) and the retained raw-text legacy template, which alone carries the **Duration** line. Timeout guidance no longer presents Claude Code `hooks.json` values as plugin behaviour: it names the budgets this plugin actually enforces (`HOOK_TIMEOUTS_MS` in `src/hook-exec.ts`, including the previously missing `after_goal: 60,000 ms`), the definitive structured timeout signal (`timed_out: true`, exit code **124**, `budget_ms`), the process-group kill semantics (SIGTERM → 2,000 ms grace → SIGKILL), and the section-level remaining-budget behaviour.

### Fixed — wrong OpenCode tool names and a phantom `/stride-build` command (D98)

AGENTS.md's Tool Name Mapping table pointed four of six rows at tools OpenCode doesn't have (`read_file`, `grep_search`, `shell`, `edit_file`, `write_file`); it now matches the README table and the agent frontmatter: `read`, `grep`, `glob`, `bash`, `edit`, `write`. Both command files (`commands/create-goals.md`, `commands/create-tasks.md`) used the same invalid names as live instructions — corrected, preserving the already-correct `glob`. Both command files and `skills/stride-workflow/SKILL.md` also referenced a `/stride-build` command that has never shipped; the wording now matches canonical — building a created task is a fresh request to work the task. Tool vocabulary is now identical across README, AGENTS.md, commands, and agent frontmatter.

## [1.25.0] - 2026-07-02

### Added — `skills_version` documented on the claim and complete payloads (W1500)

The canonical plugin sends `skills_version` on claim and complete so the server can reply `skills_update_required` when an agent's skills are stale. No opencode skill emitted the field, so the staleness nudge could never fire for opencode agents.

- **`skills/stride-claiming-tasks/SKILL.md`** — the claim payload example carries `skills_version` with a value-source note (the installed `opencode-stride` `package.json` `version` field — never a hardcoded string that rots), and the Claim Request Checklist gains an optional-field row.
- **`skills/stride-completing-tasks/SKILL.md`** — the primary `jq` completion example (`--arg skills_version` + body key), the illustrative request body, and the Completion Request Field Reference table all carry the field.
- **`skills/stride-workflow/SKILL.md`** — both inline examples (Step 2 claim, Step 8 complete) carry the field, with a prose note on the claim side and an Optional fields row on the complete side.
- **Fixed en route:** both "Handling Stale Skills" sections instructed `npm install opencode-stride@latest`, which is factually wrong — the npm package is unpublished per the README. They now give the README-consistent update path (re-clone the repository and `cp -R stride-opencode/skills/. .opencode/skills/`, bumping any `github:cheezy/stride-opencode#v<tag>` pin in `opencode.json`), and the workflow skill's terse skills-update edge case explains the trigger and points at the fuller sections.

### Backward compatibility

Documentation/skill-text only. No `src/` change (test suite unchanged at 216 passing), no wire-shape change — `skills_version` is optional and was already accepted by the API. Feature minor (1.24.2 → 1.25.0); the payload examples show `"1.25.0"`, the version this ships in.

### Source

W1500.

## [1.24.2] - 2026-07-02

### Fixed — stale `stride/agents/` path references across the skills (D96)

Five schema-ownership citations still pointed at the Claude Code marketplace path `stride/agents/task-reviewer.md` (one wrapped in a GitHub URL on the `cheezy/stride` repo) — paths that do not exist in this repository, so readers following the schema-of-record citations landed nowhere.

- **`skills/stride-completing-tasks/SKILL.md`** (3 sites), **`skills/stride-workflow/SKILL.md`** (1 site), **`skills/stride-subagent-workflow/SKILL.md`** (1 site, dropping the `cheezy/stride` GitHub link wrapper) — all five citations now use the port's plain-backtick `agents/task-reviewer.md` style already used by the files' other references, and every citation resolves to the local agent definition. Reference-only change; no schema content touched. `grep -rn 'stride/agents' skills/` now returns zero hits.

### Backward compatibility

Documentation-only. No code, wire-shape, or hook change. Bugfix patch (1.24.1 → 1.24.2).

### Source

D96.

## [1.24.1] - 2026-07-02

### Fixed — the changed-files PUT can no longer stall the after_doing gate (W1498)

`putChangedFiles` awaited `fetch` with no timeout, and the call is awaited inside the blocking `after_doing` gate — a hung or very slow server stalled task completion indefinitely, even though the upload is explicitly best-effort.

- **`src/capture.ts`** — the PUT fetch now carries `signal: AbortSignal.timeout(PUT_TIMEOUT_MS)` (exported, 10 seconds — generous enough for large diffs on slow links). An abort rejects into the existing transport-failure catch: return `0` plus the tokenless stderr warning, so the W1094 upload-state records `http_code=0` and the `before_review` self-heal retries. Success and non-2xx behavior is byte-for-byte unchanged.
- **`src/capture.test.ts`** — three new tests: the fetch receives an `AbortSignal` and the constant is 10 000 ms; an `AbortError` yields `0` with the warning and no token in the output; a timed-out attempt round-trips through the upload-state as `http_code="0"`, which fails the `/^2/` healthy check so the self-heal retries.

### Backward compatibility

No wire-shape change; the only behavioral difference is that a PUT hanging past 10 seconds now aborts into the pre-existing transport-failure path instead of blocking forever. Bugfix patch (1.24.0 → 1.24.1).

### Source

W1498.

## [1.24.0] - 2026-07-02

### Changed — the changed-files completion contract in `stride-completing-tasks` (W1499)

The skill still mandated inline-embedding `.stride-changed-files.json` into the completion payload as a hard checklist gate — redundant and error-prone now that the plugin PUTs the snapshot to the server itself — and its instructions used `CLAUDE_PROJECT_DIR`, which is unset under opencode and silently collapses to the current directory.

- **`skills/stride-completing-tasks/SKILL.md`** — The pre-completion checklist's inline-embed gate is replaced by two canonical (stride 1.33.0) items adapted to opencode conventions: the `reviewer_result` whole-object-verbatim item (mechanical `{...structured}` copy with the `project_checks` count self-check) and a per-file-diffs item stating **no agent-side action is required on Stride server v1.16.0+** — the plugin's `tool.execute.before` pass on `/complete` captures and PUTs the snapshot automatically. The primary completion example and illustrative request body omit `changed_files`. The Per-File Diff Capture section now documents the opencode plugin's real upload flow — early capture + fire-and-forget PUT before the `after_doing` gate, post-gate refresh, base64 transport envelope (D61), `.stride_auth.md`-first credential resolution, and the `before_review` upload self-heal with `.stride-diff-upload-state` bookkeeping — followed by a server-version **Backwards compatibility** matrix and the inline embed preserved only under the labelled **Legacy inline pattern (≤ v1.15.x deployments)**. Every `CLAUDE_PROJECT_DIR` reference is replaced with the port's project-dir chain `${OPENCODE_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$(pwd)}}`, and a back-compat `changed_files` row joins the field reference table.

### Backward compatibility

Documentation/skill-text only. No `src/` change (the test suite is unchanged at 213 passing), no wire-shape or hook change. The explorer/reviewer skip-form contracts and the mandatory pre-submission self-check section are untouched. Feature minor (1.23.0 → 1.24.0).

### Source

W1499 (mirrors the canonical stride 1.33.0 stride-completing-tasks contract).

## [1.23.0] - 2026-07-02

### Added — server-supplied hook env is forwarded to hook commands (W1497)

The plugin derived only `TASK_*` variables from the claim response's task record. The hook contract documents `HOOK_NAME`, `AGENT_NAME`, `BOARD_ID`, `BOARD_NAME`, `COLUMN_ID`, `COLUMN_NAME` for every hook and `GOAL_ID`/`GOAL_IDENTIFIER`/`GOAL_TITLE`/`GOAL_DESCRIPTION` for `after_goal` — none were forwarded, so hook scripts using them silently saw empty strings and the documented follow-up `PATCH /api/tasks/GOAL_ID/after_goal` could not resolve its goal id from env.

- **`src/index.ts`** — new `extractHookEnvFromResponse(responseText, hookName)` mirrors `stride-hook.sh`'s `extract_hook_env`: the claim response's **singular** `hook` object and the `hooks` **array** from complete/mark_reviewed responses are both candidates; the entry matching the routed hook supplies its `env`. Identifier keys are validated, scalar values coerced, and the client-owned `TASK_BASE_REF` is dropped (never server-overridden). The claim branch merges the `before_doing` entry env over the derived task-record values — **server wins on collision** — before the W1496 persistence, minus `HOOK_NAME` (a persisted routing value would go stale; it still reaches commands ephemerally). `executeCommands` gains an optional `extraEnv` applied last: each hook's own entry env is delivered ephemerally, and the `after_goal` entry (`GOAL_*`) reaches after_goal commands **only** — never primary commands, never the persisted cache. Older servers without hooks keys behave exactly as before; omitted keys stay absent (no client-derived `GOAL_*` from `parent_id`).
- **Payload peeling unified** — the three-shape peeling (Bash-tool `stdout` wrapper, `data` wrapper, raw object) that was duplicated between `extractEnvFromResponse` and `responseHasAfterGoal` is factored into shared `coerceOutputText`/`peelPayloadRoot` helpers, with `responseHasAfterGoal` behavior preserved (including the empty-string `.output` → `.result` fallthrough from the pre-refactor claim branch).
- **Tests** — 18 new: a 9-case unit describe for `extractHookEnvFromResponse` (singular/array/union shapes, stdout wrapper, no-match/empty-env fallbacks, `TASK_BASE_REF` and non-identifier/non-scalar drops), coercion/peeling unit tests, and a 6-test integration describe (all six shared vars reach a `before_doing` command; server `TASK_TITLE` beats the derived one and persists while `HOOK_NAME` does not; `GOAL_*` reaches `after_goal` but not `before_review` and never the cache; no-hooks fallback; newline values byte-for-byte; empty-env `after_goal` entry still routes).

### Backward compatibility

Responses without `hook`/`hooks` keys — older servers — behave byte-for-byte as before. The failure/success `HookResult` wire shapes are untouched. Feature minor (1.22.0 → 1.23.0).

### Source

W1497.

## [1.22.0] - 2026-07-02

### Added — the claim env cache is persisted to disk (W1496)

The plugin kept `envCache` (`TASK_ID`, `TASK_IDENTIFIER`, `TASK_BASE_REF`, and friends) in module memory only. A host restart between claim and complete silently dropped it: hook commands ran without task env vars, the changed-files upload was skipped for want of `TASK_ID`, and the before_review self-heal could not run either.

- **`src/capture.ts`** — new `ENV_CACHE_FILE` (`.stride-env-cache`, the same filename as the canonical bash hook; JSON format instead of shell-source) plus `writeEnvCache`/`readEnvCache`/`clearEnvCache` in the established best-effort IO style: writes swallow errors, reads degrade absent/malformed/wrong-shape files to `{}` and never throw, only string-valued entries of a plain JSON object are accepted. The filename joins the D67 `ROOT_ARTIFACTS` exclusion set so the cache never leaks into a task's `changed_files` (root-anchored: a same-named file in a subdirectory is still captured).
- **`src/index.ts`** — the claim branch performs a **fresh** `envCache` assignment (not a merge — a prior task's leftover fields cannot survive into the new claim, mirroring the bash hook's truncating rewrite) and persists the fully-populated cache (including `TASK_BASE_REF`) after the stale-state clears, gated on a successful extraction. A `loadEnvCacheIfEmpty()` helper lazily rehydrates an empty in-memory cache from disk at the three read sites: `executeCommands` (every hook path including `after_goal`), `finalizeAfterDoing` (also reached on the empty-commands path), and `selfHealChangedFilesUpload`. `after_review` removes the cache file alongside the snapshot and upload-state files (the bash hook's after_goal carve-out is out of scope — opencode has always cleared unconditionally).
- **`.gitignore`** / **`README.md`** — `.stride-env-cache` added to the ignore list and the "Gitignored state artifacts" stanza (task metadata only, **never the API token**; written at claim, reloaded after a restart, cleared at `after_review`).
- **Tests** — a 5-test unit describe in `capture.test.ts` (round-trip with `$`/backtick/quote values plus a no-token assertion, absent → `{}`, malformed → `{}`, wrong shapes dropped, clear tolerates a missing file), the D67 describe extended for the new filename, and a 9-test restart describe in `index.test.ts` (claim writes metadata only; a fresh instance's after_doing PUTs with the original `TASK_ID` **and** `TASK_BASE_REF` — proven via two post-claim commits a `HEAD~1` fallback would miss; restart self-heal; after_review clears all three files; stale-cache overwrite; corrupt-cache degradation; mid-task deletion with memory winning; two-project isolation; byte-for-byte env delivery through a fresh instance).

### Backward compatibility

No wire-shape or hook-contract change. The only behavioral change beyond the new persistence is the claim's fresh-assignment semantics, which affects only the previously-untested corner where a second claim on one instance inherited leftover fields from the first. Feature minor (1.21.0 → 1.22.0).

### Source

W1496.

## [1.21.0] - 2026-07-02

### Added — per-hook timeout enforcement (W1495)

A hung hook command (for example a test suite waiting on input) previously blocked the opencode session forever, with no signal to the agent about what stalled. Hook execution now enforces the canonical per-hook budgets from the stride-workflow Hooks Reference.

- **`src/hook-exec.ts`** (new) — hook execution extracted from `index.ts` into a focused module. `HOOK_TIMEOUTS_MS` maps the five hooks to their budgets (120s for `after_doing`, 60s for `before_doing`/`before_review`/`after_review`/`after_goal`). Budgets are **section-level**: each command runs under the budget remaining for its section, and an already-exhausted budget fails the command with exit code 124 without spawning it. On expiry the command's whole process tree is killed — the `sh -c` child is spawned detached (its own process group) and the group receives SIGTERM, a 2s grace, then SIGKILL — mirroring `stride-hook.sh`'s W1454 watchdog. A timeout failure carries `exit_code: 124` (GNU timeout convention) plus new `timed_out` and `budget_ms` fields on the failure JSON (a strict superset of the existing failure shape). Budgets, the kill grace, and the clock are injectable in the skill-gate DI style so tests run in milliseconds.
- **`src/index.ts`** — `executeCommands` is now a thin wrapper resolving the hook's budget and delegating to `executeHookCommands`; `formatHookResultJson` and the thrown `after_doing` gate error include `timed_out`/`budget_ms`; the after-path stderr message distinguishes "timed out after Ns budget" from an ordinary failure. `HookResult`/`CommandOutput` moved to `hook-exec.ts` and are re-exported.
- **`src/hook-exec.test.ts`** (new, 12 tests) + a 3-test W1495 describe in **`src/index.test.ts`** — cover the budget table, override resolution, timeout termination with wall-clock assertions, partial-output capture, second-command timeout, pre-spawn budget exhaustion, grandchild process reaping, SIGTERM-immune SIGKILL escalation, and the full hanging-gate integration flow (structured throw + W1093 early diff capture preserved).

### Backward compatibility

The success-path `HookResult` shape is unchanged; the failure shape gains only the additive `timed_out`/`budget_ms` fields (matching the bash hook's `timed_out`/`budget_seconds` convention, in ms). Blocking semantics are unchanged — a timed-out `after_doing` still throws and blocks the completion curl, and the W1093 early diff capture still runs before the gate. Feature minor (1.20.1 → 1.21.0).

### Source

W1495.

## [1.20.1] - 2026-07-02

### Fixed — hook commands now run through a real shell (D95)

Any real-world `.stride.md` hook line (`mix test`, `git pull origin main`, `mix credo --strict`) failed under the plugin with command-not-found, breaking the `before_doing` and `after_doing` quality gates entirely. `executeCommands` interpolated each line into a Bun `$` tagged template, which shell-escapes the interpolation into a single token — so only single-token commands like `pwd` ran. `envToExport` additionally built `export` statements with `JSON.stringify`, which is not shell quoting.

- **`src/index.ts`** — `executeCommands` now runs each `.stride.md` line via `sh -c` with the whole line delivered as sh's single `-c` argument, so shell parsing (multi-token commands, `&&`, pipes, redirects, quotes) happens in a real shell. `cwd` is set to the project dir via `.cwd()`, and the env cache is merged over `process.env` and passed through `.env()` as environment data — user-controlled values (e.g. task titles) can no longer inject shell syntax. `envToExport` is deleted.
- **`src/index.test.ts`** — New D95 describe (9 tests) covering multi-token commands (`git status --short`), `&&` chains (both run; stop on first failure), pipes and redirects, literal env delivery of `$`/backtick/quote metacharacters through the claim path, embedded quotes, stderr-only commands, the structured failure shape with `commands_remaining`, and the full `tool.execute.before` after_doing flow with a multi-token gate. The stale single-token-limitation note above the D65 describe is rewritten.

### Backward compatibility

The `HookResult` interface, `formatHookResultJson` output shape, and the 2000-character stdout/stderr tail truncation are unchanged — the agent workflow and `after_goal` PATCH consumers are unaffected. Bugfix patch (1.20.0 → 1.20.1).

### Source

D95.

## [1.20.0] - 2026-07-01

### Added — `API Notes & Limitations` section in the workflow orchestrator skill (G286 / W1417)

Two recurring API gotchas were undocumented, and agents kept rediscovering them the hard way: attempting to move a task to a different goal via `PATCH` (impossible — `parent_id` is creation-only and there is no DELETE endpoint), and calling the hosted API from an HTTP library whose default User-Agent the edge rejects.

- **`skills/stride-workflow/SKILL.md`** — Added an **API Notes & Limitations** section directly after **API Authorization**, mirroring the canonical stride wording: (a) tasks cannot be reparented and there is no DELETE endpoint — moving a task between goals or removing it is a human board-UI action, never to be worked around by recreating the task as a supersede; (b) raw HTTP calls must use curl or a curl/browser-like `User-Agent`, because the hosted API edge returns `403` with `error code: 1010` to default library User-Agents (e.g. `python-urllib`).

### Backward compatibility

Documentation/skill-text only. No `src/` change (the test suite is unchanged at 157 passing), no `.stride.md`/hook/wire-shape change.

### Source

G286 — W1417 (mirrors the canonical stride W1416 wording).

## [1.19.0] - 2026-06-29

### Added — `create-tasks`/`create-goals` now have an explicit terminal state, plus a Backlog claim-fail guard (G284 / W1401)

In OpenCode build mode (autonomous), the `/stride:create-tasks` and `/stride:create-goals` commands could create a task and then fall straight through the `stride-workflow` orchestrator's build loop — auto-claiming and building the just-created task. The claim fails because newly created tasks sit in the Backlog (not Ready), and the agent would then build the work outside the Stride lifecycle (no claim, no hooks, no completion record). The orchestrator had no terminal state for the create intent, unlike `stride-ideation` which stops at the written document.

- **`skills/stride-workflow/SKILL.md`** — Added a **Creation Terminal State** section: on a `create-tasks`/`create-goals` intent the orchestrator now reports the created identifiers, clears the activation marker (`$PROJECT_DIR/.stride/.orchestrator_active`), and STOPS without entering Task Discovery, claiming, or implementation. Added a **Backlog Claim-Fail Guard**: a failed claim (Backlog / already-claimed / blocked) is a terminal stop, never a fallback to building outside the lifecycle. The build loop (Steps 1–9) is unchanged.
- **`commands/create-tasks.md`**, **`commands/create-goals.md`** — Added a `## Terminal state` section: the command's terminal state is "tasks/goal created," not built; building is a separate `/stride-build`.
- **`skills/stride-creating-tasks/SKILL.md`**, **`skills/stride-creating-goals/SKILL.md`** — Added a `## Terminal state` note.

### Backward compatibility

Documentation/skill-text only. No `src/` change (the test suite is unchanged at 157 passing), no `.stride.md`/hook/wire-shape change. The build loop is unchanged; only the create-intent path gains an explicit stop.

## [1.18.0] - 2026-06-20

Documentation parity release: brings the OpenCode variant to parity with canonical **stride v1.30.0** (G254, the `created_by_agent` creation-skill documentation). Delivered under task W1232. Feature minor (1.17.0 → 1.18.0).

### Added — the creation skills now document `created_by_agent`

Agent-created tasks previously landed with `created_by_agent` nil, so the `/agents` activity feed rendered an uninformative `?` avatar on every `created` row. The creation skills now document the field on the create request bodies:

- **`skills/stride-creating-tasks/SKILL.md`** — `created_by_agent` added to the complete-task example, the Field Quick Reference table (string, create-only, forbidden on `PATCH`), and an explanatory note: set it to the plugin's own agent name (`"OpenCode"` — the exact value sent as `agent_name` on claim/complete), never the `ai_agent:<model>` token form, so one agent stays one roster identity.
- **`skills/stride-creating-goals/SKILL.md`** — `created_by_agent` added to the batch goal example with a note that the server propagates the goal's value to every nested child task.

Documentation-only: no wire-shape, hook, or auth change; `created_by_agent` is optional on create, was already accepted by the API, and is forbidden on `PATCH`. stride-opencode is not distributed through a marketplace, so there is no marketplace pin to update.

## [1.17.0] - 2026-06-19

Documentation parity release: brings the OpenCode variant to parity with canonical **stride v1.29.0** (G225, the `technical_details` documentation rollout). Delivered under tasks W1188, W1189, W1190, W1191. Feature minor (1.16.0 → 1.17.0).

### Added — the `technical_details` task field is now documented across the plugin

`technical_details` is an **optional, free-form JSON object** a task may carry to hold any additional technical context that does not fit the structured fields — data shapes, gotchas, key decisions, reference links. Unlike `testing_strategy`, it has **no fixed keys**: a task author or enricher uses whatever keys best describe the work, and leaves it as `{}` when there is nothing substantive to record. It is **not** one of the five review_queue-scored fields (`acceptance_criteria`, `testing_strategy`, `security_considerations`, `pitfalls`, `patterns_to_follow`), so a blank value is never a scoring gap. The plugin previously had no documentation for this field; agents now have one consistent definition to follow.

- **`skills/stride-creating-tasks/SKILL.md`** (W1188) — documents `technical_details` in the Field Quick Reference table, the complete-task example, and the Embedded Object Formats section (as a free-form object, explicitly contrasted with `testing_strategy`, which has fixed `valid_keys`).
- **`skills/stride-creating-goals/SKILL.md`** (W1188) — notes that nested tasks MAY carry an optional free-form `technical_details` object and that it is not a review_queue-scored field.
- **`agents/task-enricher.md` + `skills/stride-enriching-tasks/SKILL.md`** (W1189) — add `technical_details` to the enrichment guidance as an optional field the enricher MAY populate from discovered context — never fabricated, left as `{}` otherwise — with a no-secrets reminder since the object is free-form.
- **`agents/task-decomposer.md`** (W1189) — notes that a decomposed task MAY include an optional `technical_details` object.
- **`skills/stride-workflow/SKILL.md`** (W1190) — adds `technical_details` to the Step 1 task-field review list (optional free-form context; not a scored field).
- **`agents/task-explorer.md`** (W1190) — the explorer folds any recorded `technical_details` into its summary so implementation benefits from it.

### Backward compatibility

Documentation-only. No `src/` (TypeScript), wire-shape, hook, `.stride.md`, or `.stride_auth.md` changes; `technical_details` is optional everywhere it appears and is never added to any scored-field set. Tasks that omit it behave exactly as before. No marketplace pin update — stride-opencode is not distributed through stride-marketplace; consumers install directly from this repository by tag (`npm install opencode-stride`).

### Source

Tasks W1188 (creation contracts), W1189 (enrichment + decomposition), W1190 (workflow + exploration surfacing), W1191 (this release-notes/version task). Ports canonical stride G225 (v1.29.0) / G243 (W1179–W1182).

## [1.16.0] - 2026-06-14

Bundled parity release: brings the OpenCode variant to parity with canonical **stride v1.24.0–v1.28.0**. Delivered under goal **G232** (tasks W1122, W1123, D75, D76, D77, W1124). Feature minor (1.15.0 → 1.16.0).

### Added

- **`src/index.ts`, `src/capture.ts`** (W1123 / canonical v1.25.0, W1093+W1094) — **the per-file diff upload now survives an `after_doing` timeout.** The diff snapshot is captured **early** — `finalizeAfterDoing` runs before `executeCommands`, so the `changed_files` payload is built from the working tree even if a long-running command is later cut off by the host. `putChangedFiles` returns the HTTP status (or `null` when no PUT was attempted or the transport failed), and `recordDiffUploadState` / `readDiffUploadState` persist the attempt's task id + HTTP code to `.stride-diff-upload-state`. On the next claim, `selfHealChangedFilesUpload` re-attempts any upload that did not land a healthy `2xx` (short-circuiting before credential resolution when the recorded status is already healthy), and the marker is cleared at claim refresh and after `after_review`. `src/capture.test.ts` / `src/index.test.ts` cover the early-capture ordering, the state round-trip, and the self-heal path (`bun test` 157/0).

### Updated

- **`agents/task-reviewer.md`, `skills/stride-workflow/SKILL.md`, `skills/stride-subagent-workflow/SKILL.md`, `skills/stride-completing-tasks/SKILL.md`** (W1122 / canonical v1.24.0, G222 / W1072–W1076) — **review-report completeness.** The reviewer dispatch contract is expanded to pass **every** review field the task supplies (8 fields, no subset, no small-task discount), the per-section `not_assessed` verdict is restricted to "ONLY when the task itself omits the section," and a "Verdict rule for all four section tiles" paragraph is added. The completion path documents a **mechanical whole-object copy** of the reviewer's parsed JSON into `reviewer_result` plus a **MANDATORY pre-submission self-check** (every section present; `project_checks` count equals the reviewer's emitted count; no `not_assessed` for a task-supplied section) as a hard gate.
- **`agents/task-reviewer.md`, `skills/stride-workflow/SKILL.md`** (D77 / canonical v1.26.0, D66) — **verbatim acceptance-criteria restatement.** The reviewer must restate each acceptance criterion **1:1 verbatim, one entry per criterion** (no merging, splitting, or paraphrasing); the workflow skill adds the "Re-review and follow-up rounds (D66)" rule and a JS self-check that throws (forcing re-invoke) when the emitted `acceptance_criteria` count diverges from the task's criterion-line count, rather than truncating or padding.

### Fixed

- **`src/capture.ts`** (D75 / canonical v1.27.0, D67) — **the hook's own state artifacts are excluded from the `changed_files` snapshot.** A `ROOT_ARTIFACTS` set (`.stride-diff-upload-state`, `.stride-changed-files.json`) is filtered out in the dedupe pass so the upload bookkeeping marker and the captured-diff file never appear in the diff the reviewer sees.
- **`src/index.ts`** (D76 / canonical v1.26.0, D65) — **passing-gate command output is kept off `process.stderr`** and folded into the structured `commands_output` array (each entry sliced to the last 2000 chars) on the success path, so a green `after_doing` run no longer leaks noisy output to stderr; the `HookResult` shape gains `commands_output?` and `formatHookResultJson` always emits `commands_output` (defaulting to `[]`).

### Documentation

- **`.gitignore`, `README.md`** (W1124 / canonical v1.25.0+v1.27.0 hygiene; W1096 N/A) — both hook state artifacts (`.stride-changed-files.json`, `.stride-diff-upload-state`) are gitignored, with README paragraphs explaining the rationale and the `after_doing` time budget. The README **explicitly marks canonical W1096's `hooks.json` 120s→300s timeout bump as N/A for stride-opencode** — there is no `hooks.json`; hooks run inside the OpenCode `tool.execute.before`/`after` handlers, so the budget is host-controlled.

### Notes on v1.28.0 parity

Canonical v1.28.0 (G224 / W1086+W1087) made the bash plugin **always refresh `TASK_BASE_REF` at claim time** because oversized claim responses could skip the `.stride-env-cache` file refresh and leave a stale base ref. **This is structurally inherent in the OpenCode variant and needs no port:** `captureBaseRef()` recomputes the base ref from `git HEAD` on every claim and writes it to the in-memory `envCache` — there is no on-disk env cache to go stale.

### Backward compatibility

Additive. The TypeScript changes are behavior-preserving for the happy path (every prior test still passes; suite grows to 157/0). `reviewer_result` is persisted verbatim by the Kanban server (`:jsonb`), so the expanded review-report fields flow through with no consumer edit. No `.stride.md` or `.stride_auth.md` changes are required; `.gitignore` gains two transient-artifact entries. `bun install` your updated plugin and re-copy the `skills/`, `agents/`, and `src/` outputs into your `.opencode/` paths. No marketplace pin update — stride-opencode is not distributed through stride-marketplace; consumers install directly from this repository by tag (`npm install opencode-stride`).

### Source

Goal **G232** — the OpenCode TypeScript port of canonical stride v1.24.0–v1.28.0. Tasks: W1122 (G222 review-completeness), W1123 (W1093/W1094 diff-upload survives timeout), D75 (D67 exclude state artifacts), D76 (D65 passing-gate output → `commands_output`), D77 (D66 verbatim acceptance-criteria restatement), W1124 (gitignore artifacts + time-budget docs).

## [1.15.0] - 2026-06-08

Parity release: brings the OpenCode variant to G220/G219 parity for the reviewer `project_checks` `not_applicable` status and full-checklist emission (canonical: stride v1.23.0, commit a4e7e6f, W1057). Feature minor (1.14.0 → 1.15.0).

### Updated

- **`agents/task-reviewer.md`** — The `project_checks[]` per-entry `status` enum gains a third value, **`not_applicable`**, alongside `met` / `not_met`, and the reviewer is now required to **emit one entry for every top-level `CODE-REVIEW.md` bullet — never omit one**. Previously, with only `met` / `not_met` available, the reviewer silently dropped bullets that had no bearing on the diff under review (a small one-line fix surfaced only 2 of ~9 checks), so the Kanban review queue's "Code review" panel rendered a partial, ambiguous checklist. Now bullets that do not apply are marked `not_applicable` with a one-line reason in `evidence`; `not_applicable` is **approval-neutral** — it produces no paired `issues[]` entry and never contributes to `changes_requested` (only `not_met` does). `schema_version` bumps `"1.3"` → `"1.4"`, and the worked example demonstrates a `not_applicable` row.
- **`skills/stride-completing-tasks/SKILL.md`, `skills/stride-workflow/SKILL.md`** — All example `schema_version` strings bumped `"1.3"` → `"1.4"` in lockstep so no stale `"1.3"` remains.

### Backward compatibility

Documentation/agent-prompt change only — no wire-shape, hook, `.stride.md`, `.stride_auth.md`, `.gitignore`, or `src/` changes. The change is additive: `reviewer_result` is stored as `:jsonb` by the Kanban server and persisted verbatim (the v1.14.0 passthrough change), so the new `not_applicable` status value flows through with no consumer edit. Payloads from reviewers on the prior `"1.3"` schema (emitting only `met` / `not_met`) remain valid. The Kanban review-queue panel renders `not_applicable` as a neutral "N/A" pill (kanban-side, ships independently).

### Source

W1063 under goal G220 — the OpenCode port of W1057 (reviewer `not_applicable` status + full-checklist emission) from goal G219. The canonical implementation is stride v1.23.0 (commit a4e7e6f).

## [1.14.0] - 2026-06-08

Bundled release covering two ports from the main `stride` plugin (G217 + G218 parity).

### Added

- **`src/capture.ts`** (W1046 / D61) — `putChangedFiles` now uploads the per-file diff snapshot to `/api/tasks/:id/changed_files` as a **transport-encoded envelope** — `{"changed_files":{"encoding":"base64","data":"<base64>"}}` — instead of the raw `{"changed_files":[...]}` array. An edge request filter (WAF) in front of the Stride server can misread a dense code diff as an attack payload and silently drop the upload, leaving `changed_files` empty in the review queue; base64-wrapping the body (via `Buffer.from(JSON.stringify(files)).toString("base64")`) neutralizes that false positive while the server decodes it back to the identical list. Falls back to the raw `{"changed_files":files}` object (never a bare array) if encoding fails, and a non-2xx response (and any fetch error) is surfaced via `console.error` without throwing — the bearer token is never logged. `src/capture.test.ts` asserts the encoded envelope, raw-text absence, base64 round-trip, and the non-2xx warning (`bun test` 135/0).

### Fixed

- **`skills/stride-workflow/SKILL.md`** (W1054 / D63) — The "Extracting the structured review block" guidance built `reviewer_result` from a hand-maintained enumerated copy-list of structured keys that omitted `project_checks`, so the reviewer's CODE-REVIEW.md per-bullet audit was silently dropped on completion and the Kanban review queue's **Code review** panel rendered nothing. The guidance is now a **verbatim passthrough**: copy the reviewer's entire parsed JSON object into `reviewer_result` and overlay only the legacy summary fields. The fallback (no parseable JSON block) was inverted to a legacy-only send list so it no longer enumerates structured keys either.

### Updated

- **`agents/task-reviewer.md`** (W1054 / W1049) — Added an explicit **consumption invariant**: the canonical schema is the only place the structured key-set is enumerated, and the completion path MUST persist the reviewer's emitted JSON verbatim and MUST NOT maintain its own allow-list of keys to copy.

### Backward compatibility

Wire-shape: the `changed_files` envelope requires a Stride server that accepts the `base64` / `gzip+base64` encodings on `/changed_files` (ships in the kanban repo); the raw-object fallback path remains compatible with the prior shape. The `reviewer_result` change is documentation/skill-instruction only — `project_checks[]` already existed and is already rendered by the review queue; this release simply stops dropping it. No reviewer_result is constructed in TypeScript — the transport change is confined to `putChangedFiles`. Not distributed through a marketplace (installed via `npm install opencode-stride`).

### Source

W1046 (D61 base64 changed_files transport port), W1054 (D63 reviewer_result verbatim passthrough + W1049 consumption invariant). Mirrors the main `stride` plugin's 1.22.0 (D61) and 1.22.1 (project_checks) releases.

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
