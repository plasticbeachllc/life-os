# ADR 0009: Reviewed provider links and bounded subject context

Status: accepted

Gmail and Calendar add narrow CLI-only reviewed-link workflows. Gmail can associate an ingested selected
thread with a current canonical person or project. Calendar can associate one ingested primary event with a
current canonical project or task. The workflows accept source identifiers only at their provider-specific
CLI boundary, require matching current source events and canonical state, and return sanitized link results.
They do not expose an MCP mutation or change a provider or the vault.

Calendar source-event containers are event-scoped using calendar-plus-event identity. Whole-calendar
containers would let one event review accidentally authorize traversal across every primary-calendar event.
This identity change requires rebuilding stream state.

Every stream-backed Gmail and Messages extraction records a bounded subject-context snapshot, including an
empty snapshot. When reviewed links exist, it contains only canonical subject references and event provider,
kind, direction, occurrence time, and content availability through the selected event. It never retrieves or
persists cross-provider source text. The dependency identity includes current canonical state and exact
source-event versions; link or dependency changes after preparation reject submission as stale context.

Schema 25 is a prototype reset boundary. Existing provider permissions remain read-only.
