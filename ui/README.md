# LifeOS UI

Responsive Inbox and Chat interface built with SvelteKit, Tailwind CSS, and shadcn-svelte.

The Inbox reads sanitized projections from the existing LifeOS SQLite database. Chat runs through a
server-owned Codex App Server process using the current ChatGPT login and a fixed allowlist of read-only
LifeOS MCP tools. The browser receives no credentials, database access, MCP access, or filesystem tools.

The UI can trigger read-only provider ingestion, record attention lifecycle and quality feedback in
operational state, and stream bounded contextual discussion. Fixed finding-to-Inbox task proposals can
be reviewed, confirmed, applied, and undone through the same narrow policy boundary as the CLI; the UI
cannot mutate providers or perform arbitrary vault writes. Chat is session-scoped and is not added to
LifeOS SQLite or restored after the local server restarts.

Email-backed attention items keep safe display names in server-resolved discussion grounding and expose
an opaque **Open email** link. The Gmail destination is resolved only after an explicit click; the
normal browser projection contains no address, Gmail message/thread ID, raw header, or source text.
Opening Gmail is navigation only—LifeOS cannot send, archive, label, or delete mail.

```bash
bun install --frozen-lockfile
bun run dev -- --host 127.0.0.1
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

See [`../docs/release-0.1.0.md`](../docs/release-0.1.0.md) for the blocking end-to-end product gates.
