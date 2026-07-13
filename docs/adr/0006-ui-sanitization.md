# ADR 0006: Server-owned UI sanitization

Status: accepted

The browser consumes one server-built workspace projection and never accesses SQLite. Provider cards expose
generic labels and health; findings expose category/count/due metadata; proposal previews reduce validated
plans to safe effect summaries; internal subjects become opaque UI IDs. Raw identifiers, hashes, addresses,
subjects, excerpts, and database errors are forbidden from browser payloads.

Browser chat has an exact read-only MCP allowlist, read-only sandbox, no shell or network, and explicit
mutation deny list. Feedback is append-only and accepts only opaque subjects and closed outcomes; it cannot
authorize or apply an effect.
