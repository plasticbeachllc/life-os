# ADR 0007: Unified source event stream

Status: accepted

Every committed provider delta projects atomically into an immutable, provider-neutral source event.
Gmail, Messages, Telegram, Calendar, and canonical Obsidian changes share one envelope containing only
content-addressed internal identity, provider, event kind, direction, occurrence and observation times,
content availability, version lineage, and stream version.

Provider tables remain the source-specific privacy and refetch boundary. The stream does not retain raw
provider identifiers, participants, addresses, headers, subjects, locations, note paths, bodies, excerpts,
or prompt content. Identifiers for source scope, record, and container are namespaced hashes. Unchanged
provider replay emits no event; a changed version appends a new event and retains the previous version.

Global ordering is deterministic by occurrence time and opaque record identity. Causal windows use the
same order and include only current versions through the selected event. Work items may bind to an exact
stream event. The shared queue serializes work inside that event's provider container while allowing
unrelated containers to proceed concurrently.

Consequences: `change_events` remains the canonical-Markdown delta log and is projected into the stream
rather than overloaded. Cross-provider aggregation is available immediately; cross-provider causal
linking requires a separately validated canonical subject link and is not inferred from timing or content.
Schema 23 is a prototype reset boundary.
