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
- Allowlisted, incremental read-only ingestion from the local macOS Messages database.
- Bounded, high-risk-redacted Messages extraction with hash-verified refetch and sanitized review.
- Deterministic cross-provider findings projected from validated Gmail and Messages extraction items.
- Regenerable open-loop and commitment attention state feeding chief-of-staff and morning briefings.
- Zero-model deterministic triage for verification codes, notification enrollment, routine service texts,
  and order-pickup alerts.
- Primary Google Calendar read-only ingestion and deterministic compact calendar state.
- User-selected active findings can become fixed-inbox, approval-gated task proposals.

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
assessment and [`docs/email-calendar-integrations.md`](docs/email-calendar-integrations.md) for the
current provider architecture. The comprehensive target architecture, normative contracts, reference
code, and phased implementation checklist are in [`docs/architecture.md`](docs/architecture.md). The
proposed attention-signal taxonomy and intervention lifecycle are in
[`docs/findings-and-actions.md`](docs/findings-and-actions.md). Parallel contributors must also follow
[`AGENTS.md`](AGENTS.md).

## Setup

```bash
bun install
uv sync
bun run typecheck
bun test
```

uv uses the interpreter pinned in `.python-version`. Presidio and its spaCy model are pinned in
`pyproject.toml` and `uv.lock`.

## iPhone prototype

The native, read-only SwiftUI prototype lives in [`iphone/`](iphone/). Open
`iphone/LifeOS.xcodeproj` in Xcode to run its fabricated Today, Inbox, Tasks, and More screens in an
iPhone simulator. It is not connected to the vault, SQLite, providers, MCP, or mutation workflows.

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
bun run src/cli.ts findings review --vault ~/worktable/vault
bun run src/cli.ts findings dismiss <finding-id> --reason 'not actionable' --vault ~/worktable/vault
bun run src/cli.ts findings supersede <finding-id> --replacement <finding-id> \
  --reason 'replaced by newer evidence' --vault ~/worktable/vault
bun run src/cli.ts metrics efficiency --vault ~/worktable/vault
```

`state rebuild` idempotently backfills common findings from existing validated Gmail and Messages
model extractions without invoking a model. New validated extractions project immediately. Findings
retain structured meaning and internal evidence provenance in SQLite, while `findings review` omits
provider extraction IDs, reasoning-call IDs, evidence IDs, and hashes. Finding creation does not create
a task, proposal, reply, or provider mutation.

State rebuild also derives `finding_attention_state` from active findings. It tracks open loops,
commitments, and overdue finding IDs under a date- and status-aware dependency hash. Chief-of-staff and
morning briefing state consume this projection; they never query provider extraction bodies directly.

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

## Messages

Phase 1 provides read-only local ingestion for explicitly allowlisted conversations. Grant Full Disk
Access to the terminal or subscription host running Life OS, then inspect available conversations and
copy only the desired source conversation IDs into the external environment file:

```bash
bun run src/cli.ts message conversations --vault ~/worktable/vault
bun run src/cli.ts message status --vault ~/worktable/vault
bun run src/cli.ts message ingest --vault ~/worktable/vault --limit 500
bun run src/cli.ts message link-person --conversation '<source-conversation-id>' \
  --person person_example --vault ~/worktable/vault
bun run src/cli.ts message preview-extraction --vault ~/worktable/vault
bun run src/cli.ts message review-extractions --vault ~/worktable/vault
bun run src/cli.ts message triage --vault ~/worktable/vault --limit 100
```

```dotenv
LIFE_OS_IMESSAGE_ENABLED=true
LIFE_OS_IMESSAGE_SELECTION_MODE=allowlist
LIFE_OS_IMESSAGE_CONVERSATION_IDS=iMessage;-;example
```

To ingest every conversation except an explicit blacklist, use:

```dotenv
LIFE_OS_IMESSAGE_SELECTION_MODE=all_except
LIFE_OS_IMESSAGE_BLACKLIST_CONVERSATION_IDS=
```

Selection identifiers remain in the external mode-600 environment file. They are not returned through
MCP, and operational records use derived internal conversation IDs.

After ingesting a selected conversation and rebuilding canonical person state, `message link-person`
can explicitly associate that conversation with one existing person ID. The command validates the
configured Messages selection and stores only the derived internal conversation identity, bound to the
current participant-set hash. It does not merge people or expose a general association write through
MCP. Linked Messages extraction may then receive bounded person state, that person's open tasks, and
calendar entries that deterministically mention an established name or alias.

The adapter opens only `~/Library/Messages/chat.db`, read-only, and uses fixed queries. Apple's
attributed-body archives are decoded by a fixed, bounded macOS Foundation subprocess with archive data
passed through stdin. SQLite retains message and participant hashes, timestamps, direction, service,
counts, and ingestion cursors but no message text, participant addresses, display names, attachments,
or decoded archive data. Exact refetch re-reads a selected source row and rejects content or participant
drift before returning transient text.

Messages extraction preserves useful names, dates, locations, phone numbers, email addresses, and
ordinary personal context. Stock Presidio redacts only configured high-risk financial, government,
network, and medical identifiers. Preparation groups new turns by changed conversation and includes up
to twelve recent turns under a recorded token budget. Earlier turns may support interpretation, while
every extracted item must cite at least one newly changed turn. Message text is treated as untrusted and
removed from the persisted context manifest. Submission
binds the result to source, conversation, context, schema, prompt, and policy versions. Sanitized review
contains useful summaries and structured items but no evidence IDs, provider identifiers, source hashes,
participant addresses, or source text. Extraction creates no task, proposal, reply, or outgoing message.
No Messages send capability is enabled in this phase.

Deterministic service triage runs before optional model extraction. It stores only generic structured
results, never verification codes or order identifiers, and records zero model calls. The review exposes
focused sanitized queues for likely replies, open loops, upcoming dates, stale plans, and relationship
updates, along with model-versus-deterministic origin counts and pending conversation totals.

## MCP

The stdio server is configured as:

```toml
[mcp_servers.life-os]
command = "/opt/homebrew/bin/op"
args = ["run", "--env-file", "/Users/you/.config/life-os/.env", "--",
        "/opt/homebrew/bin/bun", "run", "/path/to/life-os/src/mcp/server.ts"]
```

Life OS exposes a narrow tool set covering health, compact state, briefings, Gmail, Calendar,
and Messages status/review/extraction, subscription prepare/submit workflows, and exact proposal
authorization/apply/undo. It exposes
no arbitrary path, patch, command, or generic write tool.

Morning reasoning sequence:

1. `life_os_rebuild_state`
2. `life_os_get_morning_briefing`
3. `life_os_prepare_morning_reasoning`
4. Host reasons over compact untrusted context.
5. `life_os_submit_morning_reasoning`

Email extraction sequence:

1. Deterministic Gmail ingestion with `life_os_ingest_gmail`.
2. `life_os_prepare_email_extraction`
3. Host returns schema-constrained, evidence-grounded extraction.
4. `life_os_submit_email_extraction`
5. `life_os_review_email_extractions`

Extraction never creates a proposal automatically. Converting an eligible active finding into a task is
explicit through `life_os_propose_finding_task`, which accepts only a finding ID, fixes the target to
`00 Inbox/Inbox.md`, and derives the task text, due date, stable ID, and preview.

Finding task application appends a `converted` lifecycle event in the same SQLite transaction as the
action, proposal, backup, and undo metadata. Undo reactivates the finding. Dismissal and supersession
are explicit CLI operations; no generic finding-status MCP mutation is exposed.

During the prototype phase, operational schema versions are intentionally incompatible. If the SQLite
schema version changes, delete the operational database and rebuild it from canonical Markdown and
configured providers. Life OS fails with an explicit reset instruction instead of attempting a legacy
migration. It never deletes the database automatically.

Schema v17 records explicit builder name, builder version, typed input provenance, and dependency hash
for derived state. Full rebuild retires project, person, and task projections whose canonical Markdown
inputs disappeared; targeted rebuilds can update or retire an exact state/entity pair. Identical inputs
reuse the current projection with no model call or database write. Morning recommendations remain a
separate optional reasoning overlay and never replace deterministic daily state.

Gmail and Messages extraction now run from a shared durable work queue. Provider delta commits enqueue
metadata-only work atomically, unchanged replay emits nothing, and changed source/container identity
stales older active work. A prepare call holds one bounded lease; extraction, findings, model-call
completion, and work completion commit together. After that commit, Life OS deterministically refreshes
finding attention and chief-of-staff projections and returns a sanitized refresh receipt. A refresh
failure does not roll back completed extraction work; a later state rebuild safely recovers it. Inspect
the sanitized aggregate backlog with:

```bash
bun run src/cli.ts work status --vault /path/to/vault
```

Calendar is primary-calendar-only in version 1. It retains event title, optional location, status,
start/end, all-day state, and hashes; descriptions, attendees, organizers, conference links, and
attachments are not retained. Ingest a one-day lookback and 30-day horizon with:

```bash
op run --env-file ~/.config/life-os/.env -- \
  bun run src/cli.ts calendar ingest --vault ~/worktable/vault
bun run src/cli.ts calendar status --vault ~/worktable/vault
```

Messages extraction sequence:

1. Deterministic Messages ingestion with `life_os_ingest_imessage`.
2. `life_os_prepare_imessage_extraction`
3. Host returns schema-constrained, evidence-grounded extraction.
4. `life_os_submit_imessage_extraction`
5. `life_os_review_imessage_extractions`

This workflow is read/extraction-only and cannot draft or send Messages.

Telegram ingestion uses TDLib's JSON interface as a read-only user client. TDLib owns its encrypted
local message database outside the repository; Life OS retains only normalized metadata, hashes, and
immutable version records. Raw message text, chat identifiers, sender identifiers, and credentials
are not retained in operational SQLite. Configure an explicit `LIFE_OS_TELEGRAM_CHAT_IDS` allowlist
in the external mode-600 environment file, then run:

```bash
op run --env-file ~/.config/life-os/.env -- \
  bun run src/cli.ts telegram ingest --vault ~/worktable/vault
bun run src/cli.ts telegram status --vault ~/worktable/vault
```

The TDLib session must already be authorized. If TDLib reports an interactive authorization state,
ingestion fails closed; interactive authorization tooling is not yet included.
Telegram extraction is not currently supported; status output reports this capability explicitly
and does not present ingested messages as a pending extraction backlog.

All provider ingestion plugins implement the shared contract in `src/integrations/contract.ts` and
are wired through the typed provider registry. The registry generates consistent MCP status and
ingest tools, common sanitized result envelopes, capability declarations, and bounded provider-specific
limit schemas. Provider adapters retain ownership of their narrow selection and cursor semantics.

## Verification

```bash
bun run typecheck
bun test
printf '%s' '{"texts":["Card: 4111 1111 1111 1111"]}' | \
  uv run python python/redact_sensitive.py
```

The expected redaction contains `<CREDIT_CARD>`. Tests exercise source drift, evidence validation,
context non-retention, proposal authorization, rollback, compact-state caching, and MCP allowlisting.

## UI prototype

The responsive Inbox and Chat application lives in `ui/`. Its Inbox reads sanitized projections from
the operational database, and its server-side chat bridge streams subscription-authenticated Codex App
Server turns through a fixed allowlist of read-only LifeOS MCP tools. The browser receives no provider
credentials, filesystem tools, source hashes, or raw provider content.

This first live slice cannot mutate providers, proposals, operational state, or the vault.

```bash
cd ui
bun install
bun run dev
```

See [`docs/ui-implementation-plan.md`](docs/ui-implementation-plan.md) for the staged integration and
safety plan.
