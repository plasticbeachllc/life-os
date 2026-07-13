# Roadmap conformance matrix

This matrix is the executable handoff index. “Live” means a configured provider or host process is
required; all other rows run in the normal Bun suite.

| Contract | Primary implementation | Executable evidence |
| --- | --- | --- |
| Fixed provider selection and read-only permissions | `src/adapters/`, integration registry | `config-security`, Gmail, Messages, Calendar, Telegram ingestion tests |
| Stable normalization, immutable versions, replay | provider normalizers/stores | provider ingestion tests: first, unchanged, edited, unavailable |
| Unified immutable source events and causal order | `src/events/`, provider stores, shared work queue | `source-events`, `work-queue`, Gmail causal-chain test |
| Validated cross-provider subject traversal | `src/events/subject-links.ts`, reviewed Messages link workflow | `source-subject-links`, Messages participant-change test |
| Safe cursor and partial failure | ingestion lifecycle/provider stores | `ingestion-run`, Gmail, Calendar, Telegram failure tests |
| Work invalidation, leases, retry, recovery | `src/work/` | `work-queue`, transactional provider tests |
| Per-category context budget, ranking, omission | `src/context/` | `context`, provider extraction preview tests |
| Live versus persistable context | `context/manifests.ts` | `prepared-reasoning`, Gmail and Messages audit-manifest assertions |
| Prepared lifecycle, expiry, usage | `orchestration/prepared-reasoning.ts` | `prepared-reasoning`, subscription workflow tests |
| Prompt/policy/source/container/context identity | subscription workflows and cache | Gmail, Messages, `context`, `model-gateway` |
| Injection and evidence validation | provider workflow validators | Gmail and Messages extraction tests |
| Invalid cache eviction and unchanged zero work | model gateway/work queue | `model-gateway`, provider replay tests |
| Immutable common findings and lifecycle | `src/findings/` | `findings`, `finding-attention` |
| Regenerable projections and no journal writes | `src/state/` | `projection-contract`, `rebuild-state` |
| Typed plan registry and exact authorization | `src/effects/`, `src/policy/` | `effect-registry`, `authorization`, normalization/policy/finding proposal tests |
| Atomic write, backup, failure rollback, undo | narrow effect tools | finding-task, normalization, task-normalization, policy-bootstrap tests |
| Exact MCP/CLI registration | application modules | `mcp-server`, `integration-registry` |
| Sanitized UI and read-only chat | `src/ui/`, `ui/src/` | `ui-workspace`, `ui-feedback`, UI chat boundary and notification tests |

## Local release gates

- `bun run typecheck`
- `bun test`
- `git diff --check`
- `cd ui && bun run check`
- `cd ui && bun run build`
- fresh schema-24 database creation and deterministic state rebuild
- MCP initialize/list-tools smoke test
- proposal review/authorize/apply/undo smoke test against a disposable vault

## Live gates

- Gmail `IMPORTANT`-or-`SENT` ingestion and extraction prepare using `gmail.readonly`.
- Primary Calendar ingestion using `calendar.readonly`.
- Messages configured-selection access and ingestion on macOS.
- Telegram allowlisted TDLib ingestion when configured.
- Codex App Server chat using ChatGPT subscription authentication.

Live gates never authorize writes. A missing OAuth grant, native database permission, TDLib session,
1Password session, or Codex login is reported as an external verification gap rather than bypassed.
