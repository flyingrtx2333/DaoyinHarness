# ADR-0043: Bounded task progress and process observation

- Date: 2026-10-10
- Status: Implemented; real-model acceptance recorded separately.

## Evidence

Actual cloud runs retained complete relevant code while repeatedly reading
overlapping ranges. Another run produced a useful patch, then spent its time on
successive dependency installations. The model knew the shared call count but
not the active runtime's remaining time. Existing compatibility constraints were
also available but ignored. These facts do not establish a tool failure or prove
that a prompt change alone can resolve semantic mistakes.

## Decision

Keep the shared request and tool limits. The host exposes an optional trusted
remaining-time callback to parent and child Engines; the callback follows the
existing active timer and permission pauses. The Engine reports that fact and
reminds the model to allocate delivery, verification and closeout capacity once
half its initial allowance remains. Tools stay available until the existing last
reserved request. No write quota, language rule or correctness state machine is
added to the shared kernel.

The cloud resource adapter reserves up to one maximum cloud model request for
closeout when admitting new processes, capped at one third of remaining time
so short checks remain possible near the deadline. A foreground request whose explicit
timeout exceeds available time is rejected before launch with a bounded-budget
explanation. An unspecified foreground timeout is at most 60 seconds. Background
process timeouts are bounded by available time and retain their actual timeoutAt
receipt. Existing processes can still be observed or stopped. Manual resource
API calls retain their existing execution limits. External observer deadlines
are separate and are not guessed from user text or benchmark IDs.

Add optional process_read.waitMs, an integer from 0 through 30000. It waits for
new output or a non-running state, returning the actual cursor, state and exit
code. Manual API reads remain immediate; Agent reads default to a ten-second
wait when omitted, and can request zero for immediate observation. An actual
model run ignored the optional waiting parameter and used two immediate polls;
the useful default belongs to the capability adapter rather than another prompt.
Each observation joins the existing
workspace queue; waits between observations hold no resource lock. waitMs limits
polling wait, not existing queue or Docker I/O time. Observation failure does not
prove process failure, and never relaunches the command.

File-read receipts may include bounded previous read ranges at the same actual
digest. They describe complete successful tool observations, not a content cache
or a guarantee that those observations survived context trimming. Fresh reads
are never blocked. Version guards and append-only transcripts remain unchanged.

Resource capability guidance owns coding workflow: targeted search, reuse of
available observations, coherent authorized changes, existing callers and data
format compatibility, project-declared environment preparation and focused
validation. Non-coding and read-only tasks do not require a source change. No
dataset hints, dependencies, gold patches or task-specific branches are added.

An actual follow-up task fell back to lexical routing and lost its file tools.
Negative examples must not increase positive lexical relevance; Chinese lexical
matching uses adjacent characters rather than matching every individual character
inside a phrase. Tool names remain searchable. Eligibility and intent checks are
unchanged. This fixes scoring semantics without pinning a particular task's packs.

A subsequent real run still selected process tools without the file tools needed
for its workspace task. The runtime capability declares the available resource
catalog and file packs as prerequisites. Routing admits a selected root and its
transitive dependencies together within the existing six-pack, 48-tool and
48,000-character bounds, or omits that root. Context and high-risk eligibility
remain authoritative: an unavailable prerequisite cannot be reintroduced through
a dependency. Catalogs reject dependency cycles. Read-only expansion uses the
same complete-closure rule and cannot introduce write or high-risk prerequisites.
No task wording or benchmark-specific pack pinning is added.

The day's 35 semantic-routing operations included 26 cancellations around
1,416 milliseconds and nine completions between 1,308 and 1,408 milliseconds,
while ordinary model requests had a median of 3,108 milliseconds. These observed
records support correcting the former 1.5-second semantic deadline, independently
of dependency routing. Semantic work receives a bounded ten-second allowance
alongside the host abort signal, with a twelve-second bridge transport bound.
Those limits are execution policy, not a provider latency percentile guarantee.

Profiles may provide a capability-scoped instruction renderer. The unified
workbench supplies its business instructions only while its actual business
tools are mounted, using the existing dynamic system-prompt registry. General
identity, resource safety and authorization stay in the runtime's stable rules;
profiles without a renderer keep their complete instructions. A later authorized
capability expansion recomputes the instructions on the next model request.

## Validation

Use bounded real account/model/tool/storage scenarios and the existing frozen
official SWE sample. Record source revision, model calls, actual artifacts and
outcomes independently; static checks do not prove model behavior. No mock,
legacy test or transcript-replay suite is an acceptance gate.
