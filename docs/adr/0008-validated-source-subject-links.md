# ADR 0008: Validated source subject links

Status: accepted

Cross-provider causal traversal is permitted only through explicit or reviewed assertions connecting a
provider container to a current canonical person, project, or task. A link is prepared against an exact
current source event and current canonical state. It retains opaque provider scope/container hashes,
canonical identity, basis, confidence, validation identity, and lifecycle timestamps; it does not retain
provider identifiers or source content.

Links are not inferred from content, participants, addresses, names, calendar fields, or timing. A revised
reviewed record, removed canonical subject, explicit revocation, or failed provider-specific validator makes
the link ineligible. The existing reviewed Messages conversation-to-person workflow projects into this
index and continues to require an unchanged participant-set hash.

Subject causal windows include only current event versions at or before the selected event from containers
sharing a current canonical subject. They remain metadata-only and grant no provider or vault mutation
authority. No generic CLI or MCP link mutation is introduced; each future provider needs a narrow reviewed
workflow with its own source-identity invariant. Schema 24 is a prototype reset boundary.
