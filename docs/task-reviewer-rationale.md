# Reasons behind the task-reviewer agent

`agents/task-reviewer.md` is the prompt for every review this port dispatches,
so any sentence in it that records history instead of telling the reviewer what
to do is paid for on each review. W2307 moved that history here.

This page lives in `docs/` and not beside the agent on purpose. The README
copies every `agents/*.md` file into `.opencode/agents/`, and OpenCode treats
each file there as an agent of its own, so a note placed in `agents/` would
turn into a stray agent in every project that installs the port.

A reviewer that has been dispatched never opens this file, and nothing it has
to do may depend on it. For that reason the block schema, the section verdict
rules, the consistency and verdict-note rules, the instructions to treat the
task file, the fixes list and matrix rows as data, every redaction rule and the
sentinel they share, and both blocks governed by `stride/docs/port-canon.md`
all stayed in the agent unchanged. Should this page and the agent ever disagree, the agent is
correct and this page needs an edit.

Sections follow the order of the agent. Each begins by naming the place whose
pointer leads to it.

## The Not-Assessed Report Behind the Verdict Rule

Pointer site: review step 5, the verdict rule that covers all four section
tiles.

The rule that `not_assessed` belongs only to a section the task itself left
empty came from defect D60. A task that did carry `security_considerations`
had that section come back as "not assessed". The rule closes that by
requiring a real verdict for every section the task supplied.

## Why the Block Is Copied Whole

Pointer sites: review step 8, the consumption invariant; and the item about the
reviewer's structured block in the Verification Checklist of
`skills/stride-completing-tasks/SKILL.md`.

At one point a consumer of the reviewer's output built `reviewer_result` from
its own list of keys rather than copying the emitted block. `project_checks`
was not on that list, so the field never reached the server and the Code review
panel on the Review queue rendered nothing, with no error anywhere. Copying
the whole object means a key added to the schema later travels through without
anyone having to remember a second list. The server has since started refusing
a review whose `project_checks` is missing or cut short, so the same mistake
now fails loudly.

## How schema_version Reached 1.7

Pointer site: review step 8, the `schema_version` field.

W2165 moved the version from 1.6 to 1.7 when it added the optional `cosmetic`
key to `issues[]` entries. Additive changes made before it had kept the
version at 1.6 for one reason: none of them added a field.

## Where the 6/5 Acceptance Display Came From

Pointer site: the hard rule on the `acceptance_criteria` array.

A reviewer once enumerated a task's criteria afresh instead of copying them.
The task had five criteria and the review returned six entries, so the Review
queue showed six of five criteria checked. Requiring exactly one verbatim
entry per criterion line keeps the count the reviewer reports equal to the
count the task declared.
