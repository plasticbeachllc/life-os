# LifeOS UI

Responsive Inbox and Chat interface built with SvelteKit, Tailwind CSS, and shadcn-svelte.

The Inbox reads sanitized projections from the existing LifeOS SQLite database. Chat runs through a
server-owned Codex App Server process using the current ChatGPT login and a fixed allowlist of read-only
LifeOS MCP tools. The browser receives no credentials, database access, MCP access, or filesystem tools.

The current live slice cannot mutate providers, the vault, proposals, or operational state.
Chat is session-scoped and is not added to LifeOS SQLite or restored after the local server restarts.

```bash
bun install
bun run dev
```

The development server binds where Vite reports; use `--host 127.0.0.1` to make the local-only intent
explicit. Codex must already report `Logged in using ChatGPT`, and the user-level Codex MCP configuration
must point `life-os` at this repository's `src/mcp/server.ts`.

Open the local URL printed by Vite. To verify the package:

```bash
bun run check
bun test
bun run build
```

Regenerate protocol bindings for the installed Codex CLI when upgrading it:

```bash
bun run codex:schema
```

Generated bindings are inspection artifacts and are intentionally ignored; the server adapter exposes
only the small protocol subset LifeOS uses.

See [`../docs/ui-implementation-plan.md`](../docs/ui-implementation-plan.md) for the integration plan
and the subscription-host constraint for live chat.
