# Life OS

Local-first personal organization and chief-of-staff agent for an Obsidian vault. Canonical,
human-readable knowledge remains in Markdown; operational state, audit records, caches, and compact
projections live in SQLite outside the vault.

The runtime is TypeScript on Bun. Python harnesses use uv. Model reasoning is performed by the
subscription-authenticated host agent through MCP; Life OS does not use an OpenAI API key.

## Current Capabilities

- Deterministic vault health checks, Markdown parsing, source hashing, and delta tracking.
- Versioned project, person, task, daily, and chief-of-staff state projections.
- Token-budgeted context manifests, model routing, caching, and usage instrumentation.
- Deterministic morning briefings with optional subscription-agent synthesis.
- Approval-gated, hash-checked, atomic vault proposals with backup and undo.
- Read-only Gmail ingestion for messages carrying Gmail's `IMPORTANT` system label.
- Incremental, evidence-grounded Gmail extraction through a subscription-agent prepare/submit flow.
- Stock Microsoft Presidio redaction of standard high-risk PII before email context reaches a model.
- Sanitized extraction review with no Gmail IDs, hashes, headers, addresses, subjects, or source text.
- Primary Google Calendar read-only ingestion and deterministic compact calendar state.
- User-selected email extraction items can become fixed-inbox, approval-gated task proposals.

No version 1 workflow can send or delete email, mutate Gmail labels, merge entities autonomously,
rewrite journal prose, expose arbitrary shell access, or give a model unrestricted filesystem writes.

## Architecture

```text
Obsidian Markdown                    Gmail API (readonly, IMPORTANT)
       |                                      |
       v                                      v
deterministic indexing                   deterministic ingestion
       |                                      |
       +------------> SQLite <---------------+
                         |
                 compact derived state
                         |
                 context builder/router
                         |
              MCP prepare -> host reasoning
                         |
                 validated MCP submit
                         |
                  structured state only
                         |
              approval-gated proposals
```

Every model-backed workflow uses a recorded `ContextManifest`. Workflows process changed sources,
prefer compact state over raw text, and escalate retrieval only when necessary. Prepare/submit
protocols bind reasoning to immutable source and context hashes. Model output cannot directly write
the vault or Gmail.

See [`docs/token-efficiency-inventory.md`](docs/token-efficiency-inventory.md) for the migration
assessment. Parallel contributors must also follow [`AGENTS.md`](AGENTS.md).

## Setup

```bash
bun install
uv sync
bun run typecheck
bun test
```

uv uses the interpreter pinned in `.python-version`. Presidio and its spaCy model are pinned in
`pyproject.toml` and `uv.lock`.

## Configuration

Runtime secrets and machine-specific configuration belong in `~/.config/life-os/.env`, mode `600`.
Do not create a repository-local `.env` containing Gmail credentials.

```bash
mkdir -p ~/.config/life-os
chmod 700 ~/.config/life-os
cp .env.example ~/.config/life-os/.env
chmod 600 ~/.config/life-os/.env
```

The supported 1Password pattern keeps only references in that file:

```dotenv
LIFE_OS_VAULT_PATH=/Users/you/worktable/vault
LIFE_OS_GMAIL_ENABLED=true
LIFE_OS_GMAIL_ACCOUNT_ID=me
LIFE_OS_CALENDAR_ENABLED=true
GMAIL_CLIENT_ID=op://Personal/LifeOS Google Client Secrets/client id
GMAIL_CLIENT_SECRET=op://Personal/LifeOS Google Client Secrets/client secret
```

Launch credential-dependent commands and the MCP server with `op run`. Enable 1Password CLI desktop
integration so a non-interactive MCP child can authenticate without plaintext credentials.

## CLI

Core state and briefing commands:

```bash
bun run src/cli.ts doctor --vault ~/worktable/vault
bun run src/cli.ts state rebuild --vault ~/worktable/vault
bun run src/cli.ts state show chief-of-staff --vault ~/worktable/vault
bun run src/cli.ts briefing morning --vault ~/worktable/vault
bun run src/cli.ts metrics efficiency --vault ~/worktable/vault
```

Proposal lifecycle:

```bash
bun run src/cli.ts normalize propose --vault ~/worktable/vault
bun run src/cli.ts normalize tasks --vault ~/worktable/vault
bun run src/cli.ts review --vault ~/worktable/vault
bun run src/cli.ts approve <proposal-id> --action <action-id> --vault ~/worktable/vault
bun run src/cli.ts apply <proposal-id> --vault ~/worktable/vault
bun run src/cli.ts undo <action-id> --vault ~/worktable/vault
```

Application fails closed if policy is incomplete or a source/target hash changed. Applied writes are
atomic, backed up outside the vault, audited, and reversible while the target still matches.

## Gmail

Create a Google OAuth client of type **Desktop app**, enable the Gmail API, and authorize only:

```text
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/calendar.readonly
```

Authenticate, ingest, inspect, and review:

```bash
op run --env-file ~/.config/life-os/.env -- \
  bun run src/cli.ts email auth --vault ~/worktable/vault

op run --env-file ~/.config/life-os/.env -- \
  bun run src/cli.ts email ingest --vault ~/worktable/vault --limit 50

bun run src/cli.ts email status --vault ~/worktable/vault
bun run src/cli.ts email review-extractions --vault ~/worktable/vault
```

Ingestion and extraction are separate. Ingestion stores message/thread metadata and immutable hashes,
but no bodies. Preparation refetches one selected message, verifies its ingestion hash, strips quoted
history where safe, runs stock Presidio locally, and returns bounded transient context. Submission
does not refetch Gmail; it validates against the prepared manifest and current ingested hashes.

SQLite stores structured extraction output and sanitized audit metadata. It does not retain source
excerpts, subjects, address headers, or Gmail evidence IDs in the review projection. OTPs and ordinary
business identifiers are not custom-redacted; only stock Presidio entities are enabled.

The Google refresh token is stored by the current desktop authorization adapter in macOS Keychain
under service `life-os.gmail.refresh-token`. Google client credentials remain 1Password references
resolved only into the MCP/CLI subprocess environment.

## MCP

The stdio server is configured as:

```toml
[mcp_servers.life-os]
command = "/opt/homebrew/bin/op"
args = ["run", "--env-file", "/Users/you/.config/life-os/.env", "--",
        "/opt/homebrew/bin/bun", "run", "/path/to/life-os/src/mcp/server.ts"]
```

Life OS currently exposes 20 narrow tools covering health, compact state, briefings, Gmail and Calendar status and
review, subscription prepare/submit workflows, and exact proposal authorization/apply/undo. It exposes
no arbitrary path, patch, command, or generic write tool.

Morning reasoning sequence:

1. `life_os_rebuild_state`
2. `life_os_get_morning_briefing`
3. `life_os_prepare_morning_reasoning`
4. Host reasons over compact untrusted context.
5. `life_os_submit_morning_reasoning`

Email extraction sequence:

1. Deterministic Gmail ingestion.
2. `life_os_prepare_email_extraction`
3. Host returns schema-constrained, evidence-grounded extraction.
4. `life_os_submit_email_extraction`
5. `life_os_review_email_extractions`

Extraction never creates a proposal automatically. Converting selected extraction items into tasks is
explicit through `life_os_propose_email_task`, which accepts only an extraction ID and item index,
fixes the target to `00 Inbox/Inbox.md`, and enters the standard review/authorization flow.

Calendar is primary-calendar-only in version 1. It retains event title, optional location, status,
start/end, all-day state, and hashes; descriptions, attendees, organizers, conference links, and
attachments are not retained. Ingest a one-day lookback and 30-day horizon with:

```bash
op run --env-file ~/.config/life-os/.env -- \
  bun run src/cli.ts calendar ingest --vault ~/worktable/vault
bun run src/cli.ts calendar status --vault ~/worktable/vault
```

## Verification

```bash
bun run typecheck
bun test
printf '%s' '{"texts":["Card: 4111 1111 1111 1111"]}' | \
  uv run python python/redact_sensitive.py
```

The expected redaction contains `<CREDIT_CARD>`. Tests exercise source drift, evidence validation,
context non-retention, proposal authorization, rollback, compact-state caching, and MCP allowlisting.
