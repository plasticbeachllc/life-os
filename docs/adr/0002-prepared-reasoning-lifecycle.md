# ADR 0002: Prepared reasoning lifecycle

Status: accepted

All subscription-host reasoning uses `prepared → completed|failed|superseded`. Preparation selects one
leased work subject, builds bounded live context, persists only a sanitized manifest, and records exact
workflow, task, model, prompt, source, container, context, schema, and policy identity. Submission requires
the same prepared call, unexpired lease, current source/container, policy identity, evidence allowlist, and
validated structured output.

`prepared-reasoning.ts` owns lifecycle bookkeeping. Provider workflows retain refetch, evidence, delta,
and retention semantics. `ModelGateway` is a lower-level direct transport/audit/cache service and is not an
alternative owner of subscription prepare/submit state. No API-key transport is introduced.

Prepared calls expire after a bounded interval and may not be revived. Completion is transactional with
validated findings and work completion where the workflow has queued work.
