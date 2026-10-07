# Reasons behind the stride-workflow skill

`skills/stride-workflow/SKILL.md` is read in full by the agent on every task, so
anything in it that explains a rule rather than states one is paid for again and
again without changing what the agent does. W2306 lifted that background out and
put it here: where a rule came from, which defect prompted it, what was measured
to justify it, and why the obvious alternative was turned down.

Nothing in this file instructs an agent, and running a task never requires
reading it. It could not safely be required: the copy step in the README takes
`skills/`, `agents/`, `commands/` and `AGENTS.md` into a project, and the
package's published file list leaves `docs/` out, so on those routes an agent
has no copy of this file. A plugin installed by cloning the whole repository
does have it on disk, but nothing points an agent at it. The skill names it by
its path in this repository, for whoever maintains the skill. Every gate,
matrix, decision summary, schema, self-check, snippet, prompt-injection framing
and redaction rule stayed in the skill, as did all text governed by an entry in
`stride/docs/port-canon.md` together with its anchor. If this file and the skill
ever say different things, the skill is right and this file needs fixing.

Sections appear in the order of the skill. Each one starts by naming the part of
the skill whose pointer leads to it.

## The Session That Prompted the Orchestrator

Pointer site: Purpose.

The orchestrator replaced a set of separate skills, each of which the agent was
expected to activate on its own at the right moment. Over one run of seventeen
tasks, an agent kept leaving out steps those skills marked as mandatory. The
label did not help, because the cause was structural: the agent had to remember
when to reach for each of several unconnected skills, and when it was pushed for
output it quietly dropped whichever ones looked optional. Putting every step in
one skill that is followed from start to finish takes away the moment of
remembering, and with it that way of failing.

## Why the Notice Belongs to Step 0

Pointer site: Step 0, item 3 (the Marker Contract's `.gitignore` row defers to
it).

The concern is how two reasonable habits combine. Many projects write an
`## after_doing` section that stages the whole tree, `git add -A` or similar,
before committing. The exploratory-testing extension leaves untracked files
under `.exploratory/` that contain text transcribed from the application under
test. If that directory is not ignored, the next task commit picks the files up,
and taking something out of history is a great deal harder than leaving a field
out of a payload.

The reasoning sits in Step 6.5, but Step 6.5 is the wrong moment to speak: by
then a session may already have run and written its files. Step 0 runs once per
session and is the only point at which the workflow addresses the operator, so
the notice is given there or never.

Checking again whenever the extension is present, and not only when Stride is
first installed, follows from how the two are distributed. They ship separately,
the extension usually arrives well after Stride, and an operator who added it
later would otherwise never hear about `.exploratory/`.

## Retired Plan and Review Triggers (D221)

Pointer sites: Step 3, Branch C item 2 (planning), and the opening of Step 6
(review).

Both places once carried a condition of their own beside the decision matrix,
and in each case it could disagree with the matrix. Defect D221 was the
resulting ambiguity: two rules, both apparently in force, sending the same task
down different paths.

- **Planning.** Branch C item 2 used to say to plan for "medium+ OR 3+ key_files
  OR 3+ acceptance criteria lines". That could fire on a row whose `Plan` column
  is Skip; `small, 2+ key_files` was the row where they collided.
- **Review.** Step 6 used to require review for "medium+ OR 2+ key_files". That
  disagreed with the matrix for a `small` defect carrying one key file: the same
  kind of collision, in the Review column this time.

The fix was to make the matrix the only place either decision is made and to
have both sites read its column. The size-versus-label hint the planning
condition captured was kept, but only as a signal to record that a task may be
mislabelled, never as a trigger.

## What Step 5 Used to Be

Pointer site: Step 5.

Until v1.7.0, Step 5 activated `stride-development-guidelines`, a skill private
to the project's author that this plugin never shipped. Once it was dropped, the
number was left empty on purpose: renumbering Steps 6 to 9 would have broken the
many places in the skill that refer to them by number.

## Why the Review Cap Has No Mechanical Check

Pointer site: Step 6, the paragraph after the review-round cap.

In this port the only executable check on a review is the JavaScript self-check
that runs over the reviewer's parsed JSON block. That block has no field saying
which round it came from, and nothing here saves a per-round record to disk. Any
assertion about the round would therefore be comparing a number the agent had
just supplied from its own memory against itself. A check like that cannot fail,
so it would only ever show green, which is worse than plainly admitting there is
no check. For the same reason nothing here takes a snapshot of the tree before
fixes or sorts the files they touched. The skill says outright that the cap is
followed rather than enforced so that nobody takes the self-check for something
it is not.

## Why a Blocked Review Is Defined by Action

Pointer site: Step 6, the paragraph on stopping without completing.

In stride, a review that cannot be cleared ends in a recorded `review_blocked`
status that carries a `failure.kind`. stride-opencode has no such status and no
list of failure kinds. Bringing the instruction across word for word would have
told the agent to enter a state it has no means of entering, so the port spells
out the concrete actions instead: keep the claim, send no completion, report in
the session, stop the loop, clear the marker.

## What the Specialist Security Pass Adds

Pointer site: Step 6, the deep security-considerations review.

The task-reviewer does give a verdict on `security_considerations`, but it
reviews everything at once. When the security-review extension is present, a
dedicated security-reviewer checks the diff against each listed consideration
separately, and each result goes into the completion payload. An unaddressed
consideration is then turned into a failed section with a critical issue, which
the existing review gate already refuses to pass, so a real unmitigated risk
cannot reach Done without someone having to remember to stop it.

## How Step 6.5 Got Its Number and Its Gate

Pointer site: the opening of Step 6.5.

The step went in between review and hooks as `6.5` so that Steps 7, 8 and 9, and
everything that points to them, would keep their numbers. Step 5 was left empty
for the same reason. The two-part gate (the task has manual tests and the
extension is installed) follows the same pattern as exploration and review: an
optional capability that runs only when both the task and the environment ask
for it.

## Why Exploratory Escalation Mirrors the Security Gate

Pointer site: Step 6.5, the escalation policy for a Critical finding.

Before this policy existed, a specialist security verdict could block completion
but an exploratory finding could not, and nobody had chosen that difference.
The policy makes the two match on purpose: an exploratory session that shows
the task broke something blocks completion just as an unmitigated security
consideration does. The provenance test exists so this applies only to defects
the task itself caused, and never holds up a task because of an old bug the
session happened to turn up.

## What Session Artifacts Risk in a Commit

Pointer site: Step 6.5, the session-artifacts subsection.

Committing session files is a problem only because two habits overlap: sessions
leave untracked files, and quality gates often stage everything. Neither is
wrong on its own, and one `.gitignore` line makes the overlap harmless. The line
only works if it is in place before the first session. Once git is tracking a
path, ignoring it changes nothing, and the file is committed again each time
until someone runs `git rm --cached` on it.

The entry costs nothing in projects where the directory never appears, since
ignoring a path that does not exist has no effect. The sanctioned dispatch path
is not expected to create it either: the `explorer` subagent is given no tool
for writing or editing files. The entry is there for the sessions operators run
themselves, where any session command can leave files behind.

## What Hardening Closes

Pointer site: Step 6.6.

A session that finds a bug and stops there leaves nothing to stop the bug from
quietly coming back. Turning each confirmed bug into a regression check is the
one place where the workflow can convert something learned by exploring into
something checked on every run, without anyone writing the test by hand.

## Why a Drafted Check Threatens the after_doing Gate

Pointer site: Step 6.6, the sequencing rule.

A regression check for a bug that has not been fixed is expected to fail; the
failure shows it reproduces the bug. `after_doing` is a blocking hook that
usually runs the suite, and any non-zero exit stops the completion. Put
naively, a session that did everything right would block a task that may never
have been meant to fix the bug at all. Step 6.6 runs after review and before
the hooks, so anything it drafts is already in the working tree by the time the
gate runs. That timing is why the rule is required and not just good practice.

## Why completion_summary Carries the After-Review Line

Pointer site: Step 6.6, files written after review.

This does not add a new place to record exploratory findings, which still go
only to `completion_notes` and the reviewer's `testing_strategy` note.
`completion_summary` is required, always stored, and shown on the Review queue.
The workflow already puts one line there for any fact a person must see even on
a server that may not store `completion_notes`: the credential-row refusal, the
steering-row refusal and Step 6.5's Critical escalation all do this. A file
written after the review ran is the same kind of fact.

## How after_goal Detection Survives a Truncated Response

Pointer site: Step 9, the last-child completion.

The response to `/complete` or `/mark_reviewed` can be tens of kilobytes, most of
it the echoed `reviewer_result`, and a host is allowed to shorten the output it
passes to `tool.execute.after`. W1637 and W1638 made detection independent of
that output, in three layers:

1. Whenever the output is complete, valid JSON, the plugin writes it to
   `.stride/.last-api-response.json` under the project directory. A good
   response replaces an older copy, and a truncated one leaves the previous good
   copy in place. The file is hook bookkeeping and never counted as a changed
   file.
2. When looking for the `after_goal` entry and reading its `GOAL_*` values, the
   plugin uses that file first and falls back to the live output only if there
   is no file.
3. If neither shows an `after_goal`, the plugin makes its own call to
   `GET /api/tasks/:id/after_goal_status`, using the `TASK_ID` cached at claim
   time, and runs the section from that result. This is checked against the
   first two layers so the section never runs twice, and a missing id, an
   unreachable endpoint or a goal that is not armed simply does nothing.

## The Evidence Behind the dispatch_count Limits

Pointer site: the telemetry section, "What `dispatch_count` cannot tell you".

All six limits remain stated in the skill. This section holds the measurements
and comparisons that support them, taken from the task that introduced the key
(W2130).

- **Limit (1).** Over the eight real dispatches measured then, the token rate per
  second of wall-clock varied by about 2.1 times depending on the kind of
  dispatch: roughly 300 to 375 for reviewer rounds and roughly 455 to 625 for
  specialist security passes. On the two real completion records available, the
  wall-clock pair said one task cost 20.3% more, when in tokens it cost 1.4%
  less. The order was reversed, and the gap shown was about fifteen times the
  real one.
- **Limit (2).** On those same two records, the reviewer entry's duration
  covered four dispatches while its count said two, so dividing duration by
  count overstated the average reviewer round by 40% on one and 52% on the
  other.
- **Limit (3).** In stride the deep security review also counts toward this
  limit, because its gate does not depend on a reviewer. Here it is a sub-step
  inside Step 6, which a small task skips entirely, so it never runs on the
  review-skipped path and the limit here is narrower.
- **Limit (4).** Filling missing counts with `1` rather than a larger value
  moved a sample average by more than 100%.
- **Limit (5).** stride can tell a crashed re-dispatch from a genuine second
  round after the fact by reading a saved round-count file. This port never
  writes one, which is why the skill tells you to explain in
  `completion_notes` what any count above the rounds you ran means.
- **Limit (6).** The port's only executable check, the JavaScript self-check in
  Step 6, looks at the reviewer's block and never at `workflow_steps`, and the
  completion checklist only requires the six entries to be present. On the
  server, `valid_step?/1` checks `name`, `dispatched`, `duration_ms` and
  `reason`, and checks `reason_code` against its enum separately, but nothing
  checks `dispatch_count`. Nothing reads the key yet, so a bad value today just
  means a corrupt record. It is noted so that whoever adds the next key does not
  mistake this gap for a design decision.

## Why the Record Holds No Token Count

Pointer site: the end of the `dispatch_count` limits.

A token count would solve limit (1), since tokens were the one measure that put
tasks in the right order. The task that added these keys chose to record only
what can actually be measured, and that decision stands. The reason is often
misstated: some runtimes do report tokens per dispatch, so recording them would
not mean making numbers up. What is unresolved is whether every runtime this
schema serves can provide one. Until that is answered, the wall-clock pair is
all the record holds, and it is read within the stated limits.
