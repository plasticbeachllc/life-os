# ADR 0001: Source identity and immutable versions

Status: accepted

Provider records are identified by provider-local source ID plus stable record ID, while every observed
version is identified by a deterministic content hash. Container identity (thread or conversation hash)
is separate because unchanged leaf content can acquire different meaning when surrounding context changes.

Operational rows retain metadata, hashes, cursors, and version lineage only where the provider contract
allows it. Gmail bodies are never retained. Messages and Telegram text are transient. A committed delta
atomically emits one work item keyed by workflow, source, container, contract identity, and invalidation
hash. Replay of an identical version emits neither duplicate storage nor model work.

Consequences: provider adapters remain narrow; source drift is checked after refetch; changed containers
stale prior work; provider identifiers never enter sanitized review or browser projections.
