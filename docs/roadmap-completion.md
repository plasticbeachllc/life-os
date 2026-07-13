# Architecture roadmap completion

Completed: 2026-07-12

Branch: `feature/architecture`

Operational schema: 19

## Scope

Phases 0–7 and every acceptance criterion in `docs/architecture.md` are implemented. The remaining
unchecked boxes in that document are a reusable review-question template, not roadmap work.
`docs/conformance-matrix.md` maps each contract to implementation and executable evidence. ADRs 0001–0006
record the decisions that downstream agents must preserve.

## Local gates

- Fresh schema-19 database initialized successfully.
- Canonical rebuild scanned one note, projected one person and two tasks after normalization, and reported
  zero issues.
- Disposable proposal lifecycle completed review → authorization → apply → undo.
- Concurrent schema verification passed across four Bun processes.
- MCP initialize/list-tools and exact allowlist pass in the automated suite.
- Svelte server-rendered workspace returned HTTP 200.
- Codex App Server status connected using ChatGPT subscription authentication in a read-only sandbox.
- UI type/safety check and production build pass.

## Live read-only gates

- Previous schema-12 operational database preserved at
  `~/.local/share/life-os/life-os.db.schema12-backup-20260712` before reset.
- Gmail: enabled; `gmail.readonly`; bounded ingest discovered 10 and changed 10 with zero failures/model
  calls. Identical replay changed 0 and reported 10 unchanged. Hash-verified transient extraction preview
  succeeded. No body was retained.
- Calendar: enabled; `calendar.readonly`; ingest discovered 5 and changed 5 with zero failures/model calls.
  Identical replay changed 0 and reported 5 unchanged.
- Messages: enabled; Full Disk Access succeeded; bounded ingest discovered 10 and changed 10 with zero
  failures/model calls. Hash-verified transient extraction preview succeeded.
- Telegram: disabled by configuration, so no live TDLib session was opened. The disabled state is the
  expected live result, while adapter, allowlist, replay, edit, failure, and retention behavior remain
  covered by automated tests.

Provider ingestion changed operational SQLite only. It did not send, delete, archive, label, reply, create
calendar events, modify messages, or mutate Telegram.

## Review attestation

- Canonical Markdown and operational SQLite remain separate.
- Provider access is exact and read-only.
- Unchanged input avoids storage churn and model work.
- Source, container, context, prompt, schema, policy, redaction, builder, plan, and executor identities are
  represented where relevant.
- Transient source content is absent from durable manifests, sanitized reviews, browser payloads, and work
  rows.
- Model output is untrusted, schema-validated, evidence-checked, and stale-checked.
- Derived state is regenerable and never rewrites journal prose.
- Effects accept no arbitrary executor, path, patch, command, URL, or SQL.
- Authorization is exact, short-lived, single-use, and stale-safe.
- Cursor, finding, work, cache, proposal, apply, and undo failure paths are covered.
- Shared schema and application-surface ownership is explicit.
