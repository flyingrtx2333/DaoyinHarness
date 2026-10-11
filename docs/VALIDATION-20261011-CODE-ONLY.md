# Generic environment and regression loop: code-only iteration

Date: 2026-10-11. Base checkout: `e9d5258878b220b3b80efdbab2a55ea24bed7ac0`, root `main`, synchronized with origin before edits. Architecture: ADR-0049.

## Observed regression cause

The prior real candidate added a chained-exception serialization branch selected by the presence of `chain`. It returned only `chain` and `sections`, dropping existing top-level `reprtraceback` / `reprcrash` fields. Ordinary exceptions also entered that branch. Two existing consumers indexed `longrepr["reprtraceback"]` and failed with `KeyError`; the new issue tests passed. This is a public-data compatibility regression, not an official-grader environment failure.

Source evidence, retained unchanged:

- `.cache/swebench-cloud-live/2026-10-11T04-32-04.807Z_3a7498f9/pytest-dev__pytest-5787/prediction.patch`.
- `.cache/swebench-grade/2026-10-11T04-50-01.028Z_875b334c/logs/run_evaluation/daoyin-verified-3-c78aa7d0/daoyin-cloud-1901330e377b/pytest-dev__pytest-5787/test_output.txt`, failures `test_xdist_longrepr_to_str_issue_241` and `test_deserialization_failure`.

The cloud run had not completed a regression rerun before exhausting its 24-tool allowance. Environment preparation and tool scheduling contributed to missing the feedback loop; they did not themselves delete the fields. No candidate patch, official test or benchmark fixture was edited in this iteration.

## Implemented changes

- Environment inspection includes the trusted runtime catalog in the same response, reducing the observations needed to choose a candidate. It extracts bounded literal pins, constraints and Python metadata classifiers without evaluation. Conflicting/unavailable actual interpreter versions remain unknown; constraints/classifiers alone are unconfirmed, never guessed upper bounds or a compatibility guarantee. Raw declaration evidence remains available.
- Capability-owned tool roles record attempted reads, writes, preparation, execution and coordination. Each model request gets actual remaining tool balance and a suggested reserve based on unverified resources, unresolved checks, pending operations and plan steps. This is advisory allocation inside the existing budget; authorization, tool availability and actual allowance remain authoritative. It does not add model requests, impose a forced edit or automatically renew a run.
- New verification receipts carry a digest of the actual command identity. Another command sharing the model-selected scope cannot overwrite a failed check. Repeated observations update their own process only; old receipts cannot reinstate an obsolete source version after a mutation or newer process. Legacy events are preserved; unidentified historical checks are not silently erased.
- Generic resource guidance requires inspection of affected callers/data contracts, reproduction plus relevant existing-behavior checks, responsibility-layer repair and rerunning the same check against final source. Preparation/probes omit acceptance labels. It reserves plan closeout and discourages repeated short polls of a single operation. No issue IDs, repository repair rules, automatic interpreter downgrade or command-name-based correctness rule was added to runtime code.

## Verification and delivery boundary

Mac checks: protocol TypeScript build; agent-core and server-cloud TypeScript type checks; focused lint on the changed verification/budget/registry/protocol/environment/resource-tool files; `git diff --check`. Checks passed. Production test files were excluded by the existing TypeScript configuration. No tests, mocks, transcript replay, gateway/model requests or official-grader rerun were executed.

**Additional model calls: 0.** The existing 99-request/CNY 5 ledger was not changed. The earlier official result remains **2/3** and does not validate this revision. This iteration changes Harness source only; it does not modify the main platform, deploy or restart services. Unrelated IM and other local changes were preserved.

Behavioral acceptance remains unperformed under the owner's code-only instruction. In particular, selecting a suitable environment and acting on the suggested budget still depend on the model's decisions; the stronger receipt identity protects evidence but cannot itself guarantee regression coverage or SWE 3/3.
