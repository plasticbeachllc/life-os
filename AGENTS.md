# Agent Collaboration Guide

This repository is designed for parallel implementation of integrations without parallel erosion of
safety boundaries. Read this file before editing code.

## Runtime Rules

- Use Bun for TypeScript commands, tests, scripts, and runtime services.
- Use uv for every Python environment and invocation. Do not use global `pip` or ad hoc virtualenvs.
- Keep canonical user knowledge in Obsidian Markdown and operational state in SQLite.
- Never place credentials, resolved secrets, email bodies, or private source excerpts in the repo.
- Do not add OpenAI API-key authentication. Model reasoning is supplied by the subscription host via MCP.
- Do not introduce arbitrary shell, path, patch, SQL, or filesystem-write arguments to MCP tools.

## Non-Negotiable Invariants

- Models do not receive unrestricted filesystem writes.
- All vault mutations use narrow tools, deterministic policy checks, source/target hashes, atomic writes,
  audit records, backups, and explicit approval.
- Gmail remains `gmail.readonly`; no send, delete, archive, or label mutation in version 1.
- Google Calendar remains `calendar.readonly`; primary-calendar ingestion does not create or modify events.
- Ingestion and extraction remain separate stages.
- Every model-backed workflow goes through the context builder/router and records a manifest.
- Prepare/submit calls bind output to immutable source and context hashes and reject stale state.
- Human-authored journal prose is never rewritten.
- Canonical entity/task IDs are stable. Do not silently merge or replace them.
- Compressed state retains provenance and is regenerable from canonical sources.
- Audit/review projections must not leak raw source text or provider identifiers unnecessarily.

## Integration Shape

New integrations should follow this pipeline:

```text
provider adapter (narrow permissions)
  -> deterministic ingestion/normalization
  -> immutable source hashes and change events
  -> metadata-only SQLite records
  -> bounded context preparation
  -> subscription-agent structured extraction/reasoning
  -> validated derived state
  -> separately reviewed proposal
  -> policy-authorized mutation
```

An integration is not complete if it jumps directly from provider content to a model prompt or from
model output to a mutation.

## Ownership Boundaries

Parallel agents should claim one integration or one shared subsystem per branch/worktree.

| Area | Primary files | Coordination requirement |
| --- | --- | --- |
| Provider adapters | `src/adapters/<provider>.ts` | May be developed independently when interfaces are provider-specific. |
| Provider persistence | `src/<provider>/`, `src/db/schema.ts` | Coordinate all schema edits; schema version has one linear owner. |
| Provider workflows | `src/workflows/<provider>-*.ts` | Keep provider behavior behind narrow workflow functions. |
| Context | `src/context/` | Shared contract; do not add workflow-local prompt concatenation. |
| Model orchestration | `src/orchestration/` | Shared contract; changes require cross-workflow tests. |
| Policy/authorization | `src/policy/`, write tools | Single-owner changes; never weaken invariants for one integration. |
| MCP surface | `src/mcp/server.ts` | Coordinate tool names and update the exact allowlist test. |
| CLI surface | `src/cli.ts` | Keep commands provider-scoped and update README usage. |
| Privacy harness | `python/`, `pyproject.toml`, `uv.lock` | Stock Presidio only unless the user explicitly approves custom policy. |

Avoid concurrent edits to `src/db/schema.ts`, `src/mcp/server.ts`, `src/cli.ts`, and lockfiles. If two
integrations require them, designate one integration agent to own the shared merge after provider-local
work is ready.

## Database Changes

- During the early prototype phase, internal schemas may be replaced rather than migrated compatibly.
- Coordinate schema ownership and increment `schemaVersion` exactly once per schema revision.
- Treat SQLite as disposable prototype state; canonical user knowledge remains in Obsidian Markdown and
  configured providers. During active prototype development, agents may reset all Life OS operational
  state (SQLite, caches, manifests, and backups) without a compatibility migration when needed; preserve
  the Obsidian vault and external credentials/configuration. Rebuild operational state from canonical
  sources after a reset.
- Do not spend prototype effort on backward-compatible schema migrations or operational-state retention
  unless the user explicitly requests a release/migration plan.
- Store provider bodies only when the specification explicitly permits it. Gmail bodies are forbidden.
- Use JSON columns for structured projections, not serialized prompt blobs.
- Add indexes and uniqueness constraints for idempotency and cache identity.
- Cache keys must include workflow, prompt, model, source, context, schema, and policy versions where relevant.
- Test fresh schema creation, incompatible-version rejection, unchanged replay, changed source, and
  concurrent/stale submission behavior.

## MCP Tool Rules

Every tool must:

- have a narrow verb and provider/domain-specific schema;
- declare read-only/destructive/idempotent annotations accurately;
- reject arbitrary paths, commands, patches, URLs, and SQL;
- return a sanitized projection rather than raw database rows;
- enforce permissions after model output, not trust prompt instructions;
- update `tests/mcp-server.test.ts` when added or removed.

Mutation tools require a prepare/review/confirm boundary and a token bound to the exact action and hash.

## Context and Token Efficiency

- Process deltas; do not reprocess unchanged provider records.
- Prefer metadata (level 0), compact state (level 1), and relevant sections (level 2).
- Retrieve full source material (level 3) only for explicit verification or unresolved ambiguity.
- Record included and omitted items, token budget, retrieval levels, context hash, and escalation count.
- Do not persist raw transient context merely because it appeared in a model call.
- Do not recursively summarize without bounded depth and canonical source links.

## Privacy and Credentials

- Store only `op://` references in external environment files when using 1Password.
- Resolve references with `op run` into the narrow provider subprocess.
- Never print resolved credentials, include them in command arguments, or return them through MCP.
- Pass privacy-harness text through stdin, not argv.
- Stock Presidio handles standard high-risk PII. OTPs and ordinary business identifiers are intentionally
  not custom-redacted. Do not add custom recognizers without explicit user approval.
- Sanitized reviews may expose useful summaries but not provider message IDs, source hashes, raw headers,
  subjects, addresses, or source excerpts.

## Tests Required Per Integration

At minimum, add tests for:

- narrow provider selection and permission scope;
- deterministic normalization and stable hashes;
- unchanged replay with zero duplicate records/model work;
- changed source or thread invalidation;
- no forbidden body/source retention;
- bounded context and policy compilation;
- prompt-injection indicators and untrusted-content treatment;
- evidence allowlisting and schema rejection;
- stale prepare/submit rejection;
- sanitized MCP/CLI review output;
- no proposals or mutations unless the workflow explicitly reaches that stage.

Run before handoff:

```bash
bun run typecheck
bun test
git diff --check
```

For Python changes also run a focused `uv run` smoke test. Do not claim completion when a required
runtime dependency, MCP reload, OAuth grant, or live provider verification remains outstanding.

## Handoff Format

Each parallel agent should report:

1. Files and schema versions changed, including any required prototype database reset.
2. New commands, MCP tools, and permissions.
3. Data retained and explicitly not retained.
4. Cache and invalidation identity.
5. Tests and live checks run.
6. Known gaps, reset/backfill steps, and required reloads.

Keep unrelated refactors out of integration branches. Work with existing user changes and never reset,
revert, or overwrite another agent's work to simplify a merge.
