# Token-Efficiency Revision Inventory

Assessment recorded before restructuring, per Revision Step 1.

| Component | Status | Decision | Notes |
| --- | --- | --- | --- |
| Configuration | Complete foundation | Retain unchanged | Bun environment configuration already separates vault and operational data paths. |
| SQLite schema/store | Partial | Extend | Runs, actions, results, file versions, and workflow state exist. Add instrumentation, deltas, cache, manifests, and derived state additively. |
| Vault indexing | Partial | Extend | Markdown discovery and parsing exist. Add persisted content and relevant-section hashes later; do not add full-vault vector indexing. |
| File adapter | Complete foundation | Retain unchanged | Read-only Obsidian adapter is narrow and compatible with source-grounded retrieval. |
| Source hashing | Partial | Extend | SHA-256 helpers exist. Add stable structured/context/cache hashing and invalidation inputs. |
| Policy engine | Partial | Extend | Mandatory policy loading and hard invariants exist. Add deterministic workflow-specific policy compilation before model calls. |
| Gmail ingestion | Not started | Defer | Implement after context/state foundations; preserve ingestion/extraction separation. |
| Extraction prompts | Not started | Defer | Introduce only behind the model gateway and context builder. |
| Briefing generation | Not started | Defer | Morning and weekly workflows follow compact state and delta tracking. |
| Model adapter | Not started | Add | All future calls must pass through an instrumented gateway, router, and context builder. |
| Project state | Not started | Add first | Deterministic projection with source hashes and versioning. |
| Person state | Not started | Add second | Deterministic projection with source hashes and versioning. |
| Task/chief-of-staff state | Not started | Defer | Add after project/person projections prove the state contract. |
| Proposal/review/undo | Not started | Defer | Required by the governing spec, but outside this context-layer migration slice. |
| Tests | Partial | Extend | Existing doctor/parser/store tests remain; add migration, hashing, projection, budgeting, and model instrumentation tests. |

## Baseline

There are currently no model calls, prompt constructors, extraction workflows, Gmail workflows,
or briefing workflows in the runtime. Therefore current model-call count and token use are zero,
and there are no "highest-token" workflows to rank yet. Instrumentation must exist before the
first model adapter is introduced; the first real workflow will establish the baseline rather than
being compared against an uninstrumented predecessor.

## Migration Boundary

This revision keeps the existing Bun/TypeScript runtime and uses the memo's Python paths only as
conceptual module boundaries. New modules live under `src/context`, `src/orchestration`, and
`src/state`.
