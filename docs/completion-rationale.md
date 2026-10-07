# Reasons behind the stride-completing-tasks skill

`skills/stride-completing-tasks/SKILL.md` is loaded in full every time an agent
completes a task, so a paragraph in it that justifies a rule instead of stating
one costs the same on every completion and changes nothing the agent does.
W2307 took those paragraphs out and collected them here: the incidents a rule
answers, the figures the skill used to quote, and the reasoning behind two of
its pre-submission checks.

No agent is told to do anything by this file, and completing a task never
depends on reading it. That has to be so. The README's copy step brings
`skills/`, `agents/`, `commands/` and `AGENTS.md` into a project, and the
published package lists its files without `docs/`, so an installed agent
usually has no copy of this page at all. The skill names it by its path in this
repository for the people who maintain the skill.

Everything an agent acts on stayed in the skill: the completion field reference,
the hook result format, both result shapes, the skip-reason enum, the
pre-submission self-check, the severity mapping and the redaction rule. Several
sections that only restated other parts of the skill were removed outright
rather than moved here, because every rule they carried is still stated in the
skill. Those were the completion flowchart, the plugin half of the hook
execution pattern, the Red Flags list, the Rationalization Table, the Common
Mistakes examples, the numbered Implementation Workflow and the Quick Reference
Card. Background on why the reviewer's block is copied whole sits in
`docs/task-reviewer-rationale.md`, next to the agent that emits the block, and
the reason one line about post-review checks goes into `completion_summary` is
already given in `docs/orchestrator-rationale.md`, so the skill points there.
When this page and the skill disagree, trust the skill and correct this page.

Sections follow the order of the skill, and each begins by naming the place in
the skill whose pointer leads to it.

## Why the Skill Is Mandatory Before Completing

Pointer site: the notice at the top of the skill, after its list of required
fields.

The completion endpoint wants several fields that an agent working from memory
tends not to know about, and the skill is the only place in this port that
lists them. An agent that skips the skill finds those fields one rejected
request at a time. The skill used to call this "observed in practice"; no
record of the sessions behind that remark is kept in this repository, so treat
it as the reason the notice exists rather than as a measured result.

## Figures the Skill No Longer Quotes

Pointer site: The Critical Mistake.

Earlier versions of the skill carried a set of numbers meant to show what
running hooks before completion buys. A Real-World Impact section claimed that
before the skill 40% of completions had failing tests, fixing them took 2.3
hours on average and 65% needed reopening, against 2%, 15 minutes and 5%
afterwards, and it summed this up as a 90% cut in rework. The Rationalization
Table added that `after_doing` catches 40% of issues and that two or three
minutes of hooks saves more than two hours.

Neither the skill nor anything else in this repository says where these numbers
came from, how they were measured, or on which projects. They are listed here
only so that their removal is on record. Do not cite them as evidence.

## What the Verification Checklist Is For

Pointer site: the line that closes the Verification Checklist.

The checklist is a deliberate stopping point. When agents were pressed to
deliver quickly, they kept skipping exploration, review and the hooks, each of
which looks optional at the moment it is skipped. Asking for an
explicit yes against each of them right before the completion call puts the
skipped phase in front of the agent while there is still time to run it.

## Why Presence in issues[] Is Not Read as Unfixed

Pointer site: the pre-submission self-check, the item on residual findings at
the two-round ceiling (W2164).

That item forbids recording an unfixed `critical`, or an unfixed finding in the
security category, as a mere residual. It would be simpler to check for those
by looking for them in the submitted `issues[]`, but two other items in the
same self-check require exactly such entries to be present: the exploratory
escalation keeps an introduced Critical in `issues[]` after it has been fixed
and reviewed again, and the deep security review appends a security entry to
`issues[]` as part of its escalation. If being listed counted as being unfixed,
the residuals item would refuse the very payloads those two items demand, and
the only thing blocking the task would be the record of its own fix.

So the item treats "not fixed" as something the agent knows, not something the
payload shows. The cost of that is that a fixed entry and a shipped, unfixed one
look the same in `issues[]`. Naming each such entry in `completion_notes` and in
one line of `completion_summary`, and saying it was fixed, is what lets a person
reading the task tell them apart. It matters most for security findings: the
reviewer documents `important` as its default severity for one, so treating an
`important` security finding as an ordinary residual would ship the weakness
it describes.

## Why the Residuals Item Has an Exit

Pointer site: the same residual-findings item, where it sends the agent to stop
and report instead of invoking the reviewer again.

The general remedy in the self-check is to invoke the reviewer once more. That
only ends if something changes between rounds. A finding the agent cannot fix
will be raised again in the next round, and the reviewer's own contract forbids
it to lower a severity on a later invocation, so the loop never ends. The
self-check meets the same problem with a credential-bearing matrix row, which
the reviewer has to echo every time, and solves it the same way: the agent
leaves the loop instead of hoping for a quieter verdict. Stopping keeps every
check intact; it only refuses to submit.

## Strict Validation and Its Grace Period

Pointer site: Explorer/Reviewer Result Schema, under Grace-period rollout.

The server validates `explorer_result` and `reviewer_result` behind a flag.
With the flag off, a missing or malformed value is logged as a warning and the
completion goes through. With it on, the same payload is refused with a `422`.
An agent cannot see from its side which way the flag is set, and the server
can change the setting at any time. A payload that only works
while validation is lenient therefore fails without warning on the day the
flag turns on, which is why the skill tells the agent to send correct values
regardless.
