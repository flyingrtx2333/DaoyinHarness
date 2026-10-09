# ADR-0038: Bounded recovery of incomplete cloud model responses

The owner requested automatic continuation after model response failures while preserving completed business operations. This supersedes older blanket no-retry wording only for the cases below.

A cloud model operation that ends with an explicit incomplete-response error or temporary model-service transport error may start a fresh model operation with the same confirmed conversation and tool observations. The Agent permits at most two such recoveries per turn, charges each attempt to the existing shared model budget, and leaves a call for closure. No business tool is replayed by recovery; only a complete validated response can dispatch tools. Authentication, billing, cancellation, model deadlines, policy failures and malformed tool authorization remain terminal. Context rejection retains its separate existing bounded reduction path.

If public text was persisted before failure, its original append-only delta events remain. A derived commentary marks that content as an unfinished response, and the next attempt receives a new content block. Pending chunks are drained/discarded before switching blocks; incomplete text never becomes confirmed tool history. Recovery is visible in the progress stream. There is no promise of universal success: exhaustion reports the actual stage and retains completed results.

Model-authored commentary is displayed as normal Markdown between chronological tool rows. Runtime status and system fallback goals remain progress rows.

Validation uses only bounded real account/model/tool/storage scenarios. Static checks, UI evidence and deployment are reported separately; faults are not simulated and the occurrence of a live recovery is reported only if actual events prove it.
