# Operating Life OS locally

This guide is the practical companion to the [architecture](architecture.md). It covers the supported
local workflow without weakening the system's read-only provider and approval-gated vault boundaries.

## Prerequisites

- macOS for the local Messages adapter, macOS Keychain Gmail token storage, and the iPhone prototype.
- [Bun](https://bun.sh/) for the TypeScript runtime and tests.
- [uv](https://docs.astral.sh/uv/) for the Python privacy harness.
- An Obsidian vault. Markdown in the vault is canonical; the SQLite database is disposable operational
  state.

Install the repository dependencies and run the baseline checks:

```bash
bun install
uv sync
bun run typecheck
bun test
```

## First local run

No provider needs to be enabled for these commands. Replace `/path/to/vault` with an existing vault.

```bash
bun run src/cli.ts doctor --vault /path/to/vault
bun run src/cli.ts state rebuild --vault /path/to/vault
bun run src/cli.ts state show chief-of-staff --vault /path/to/vault
bun run src/cli.ts briefing morning --vault /path/to/vault
```

`doctor` reports configuration and vault health. `state rebuild` derives compact state from canonical
Markdown and existing validated extractions. It does not invoke a model and does not rewrite journal
prose. `briefing morning` produces the deterministic briefing; optional host reasoning is a separate
MCP prepare/submit workflow.

For the daily loop, run the bounded refresh command:

```bash
bun run src/cli.ts today refresh --vault /path/to/vault
```

It attempts ingestion only for enabled read-only providers, isolates a failed provider from the rest of
the refresh, then rebuilds compact state and the attention queue. It never invokes a model, sends a
message, changes a provider, or writes the vault. The local UI exposes the same server-owned action as
**Refresh Today** and reloads its sanitized review queue after completion.

## Local configuration

Life OS reads machine-specific settings from `~/.config/life-os/.env` by default. The file must be a
regular file owned by the current user with mode `600`; provider secrets must not be kept in a workspace
`.env` file. Use the repository template as a starting point:

```bash
mkdir -p ~/.config/life-os
chmod 700 ~/.config/life-os
cp .env.example ~/.config/life-os/.env
chmod 600 ~/.config/life-os/.env
```

Set `LIFE_OS_VAULT_PATH`, or pass `--vault` to every CLI command. Database and backup locations default
under `~/.local/share/life-os` when not explicitly configured. `config.example.toml` is a reference for
the intended configuration shape; the current runtime loads environment variables.

When credentials are held in 1Password, put only `op://` references in the external environment file
and run credential-dependent commands through `op run`:

```bash
op run --env-file ~/.config/life-os/.env -- \
  bun run src/cli.ts email ingest --vault /path/to/vault --limit 50
```

## Provider workflows

All provider adapters are read-only. Ingestion is deterministic and separate from model-backed
extraction. It records normalized metadata, hashes, and immutable versions; it does not create tasks,
send messages, or modify provider data.

| Provider | Enable/configure | Inspect and ingest | Important boundary |
| --- | --- | --- | --- |
| Gmail | Set `LIFE_OS_GMAIL_ENABLED=true`; create a Desktop OAuth client and grant only `gmail.readonly`. | `email auth`, `email status`, `email ingest --limit 50` | Only messages with `IMPORTANT` or `SENT` are selected. Bodies are refetched transiently for extraction and are not retained. |
| Google Calendar | Set `LIFE_OS_CALENDAR_ENABLED=true`; the Gmail OAuth client must also have `calendar.readonly`. | `calendar status`, `calendar ingest --limit 500` | Primary calendar only. No events are created or changed. |
| Messages | Set `LIFE_OS_IMESSAGE_ENABLED=true` and an explicit allowlist (or `all_except` blacklist); grant the host Full Disk Access. | `message conversations`, `message status`, `message ingest --limit 500` | Opens only `~/Library/Messages/chat.db` read-only. No send capability exists. |
| Telegram | Set `LIFE_OS_TELEGRAM_ENABLED=true`, TDLib credentials, and `LIFE_OS_TELEGRAM_CHAT_IDS`. | `telegram status`, `telegram ingest --limit 50` | An already authorized TDLib session and an explicit chat allowlist are required. Extraction is not supported. |

For Gmail, first authorize the desktop client:

```bash
op run --env-file ~/.config/life-os/.env -- \
  bun run src/cli.ts email auth --vault /path/to/vault
```

The refresh token is stored in macOS Keychain. Google client credentials stay in the external
environment and are resolved only in the command subprocess.

After ingestion, inspect the sanitized work backlog with:

```bash
bun run src/cli.ts work status --vault /path/to/vault
```

## Review, reasoning, and changes

The normal state and review commands are read-only except for explicit finding lifecycle updates:

```bash
bun run src/cli.ts findings review --vault /path/to/vault
bun run src/cli.ts email review-extractions --vault /path/to/vault
bun run src/cli.ts message review-extractions --vault /path/to/vault
bun run src/cli.ts metrics efficiency --vault /path/to/vault
```

Gmail and Messages reasoning must use the corresponding MCP prepare/submit pair. Preparation returns
bounded, redacted, untrusted transient context and records a manifest. Submission validates evidence
and rejects stale source, context, and policy state. Review projections omit raw provider text,
identifiers, headers, addresses, and hashes.

For a deliberate one-item functional evaluation, use the user-triggered subscription runner:

```bash
op run --env-file ~/.config/life-os/.env -- \
  bun run src/cli.ts extract one --provider gmail
```

Choose `--provider imessage` for one Messages conversation. The runner prepares one exact context,
runs the subscription host in a read-only/no-network process with user configuration and MCP tools
disabled, validates the structured result through the normal submit path, and prints only aggregate
receipt fields. It cannot create a task, proposal, provider change, or vault write.

Run a bounded sequential evaluation batch with:

```bash
op run --env-file ~/.config/life-os/.env -- \
  bun run src/cli.ts extract pilot --gmail 5 --imessage 5
```

The pilot continues with the other provider after a host or validation failure, but stops the failing
provider so one rejected item cannot consume the remaining sample or exhaust its retry budget. Failed
work is safely requeued under its bounded attempt limit. Output contains classification, item, relation,
ambiguity, and failure counts only.

The browser Inbox exposes bounded feedback on each reviewable attention card: **Useful**, **Handled**,
**Wrong**, **Duplicate**, and **Not relevant**. Feedback is bound to the exact opaque presentation
identity and stores no free text or provider payload. Terminal judgments remove that presentation from
the Inbox on reload; aggregate reviewed/useful/other counts appear in the operational overview.

Vault writes are always proposal-based. Review the proposal, obtain exact authorization, apply it, and
use the action ID for undo if the target has not changed:

```bash
bun run src/cli.ts review --vault /path/to/vault
bun run src/cli.ts approve <proposal-id> --action <action-id> --vault /path/to/vault
bun run src/cli.ts apply <proposal-id> --vault /path/to/vault
bun run src/cli.ts undo <action-id> --vault /path/to/vault
```

Available proposal sources include metadata normalization, task-ID normalization, policy bootstrap, and
an eligible active finding converted into the fixed inbox. In the local UI, **Create inbox proposal**
can create only that fixed proposal from a currently displayed eligible finding; it cannot supply task
text, IDs, or paths, and it cannot apply the proposal. There is no generic filesystem-write command.

## MCP and local interfaces

Run the stdio MCP server with:

```bash
bun run mcp
```

When provider credentials are needed, wrap it in `op run` as shown above. The server provides narrow
status, ingestion, compact-state, review, prepare/submit, and exact proposal tools. Its exact public
allowlist is asserted in `tests/mcp-server.test.ts`; it has no arbitrary path, shell, SQL, patch, or
generic write tool.

The SvelteKit UI is a separate local development server:

```bash
cd ui
bun install
bun run dev
```

It receives sanitized workspace data only. Its chat bridge is limited to read-only Life OS MCP tools.
The SwiftUI prototype in `iphone/` is fabricated, read-only preview data and has no runtime connection
to Life OS.

## Database reset and recovery

The current operational SQLite schema is **25**. Prototype schema changes are deliberately
incompatible. If a command reports an incompatible database schema:

1. During active prototype development, discard the operational database, caches, manifests, and backups
   when a clean test is more useful than compatibility preservation. Preserve vault Markdown and external
   credentials/configuration.
2. Run `state rebuild` and re-ingest configured providers.

SQLite contents, caches, manifests, and projections are regenerable; canonical knowledge remains in the
Obsidian vault and configured read-only providers. Do not build compatibility migrations during this
prototype phase unless a release plan explicitly requires them.

## Handoff checks

Before sharing a change, run:

```bash
bun run typecheck
bun test
git diff --check
```

For changes to the privacy harness, also run a focused `uv run` check. For UI changes, run `bun run
check` and `bun run build` from `ui/`.
