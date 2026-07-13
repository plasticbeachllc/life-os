# ADR 0003: Provider-independent semantic findings

Status: accepted

Validated Gmail and Messages extraction items deterministically project into immutable common findings.
The finding kind and owner enums are closed and shared with prompt validation. Identity is derived from
source extraction and item index; content conflicts fail closed. Internal evidence and reasoning lineage
remain available for audit but are removed from review projections.

Lifecycle changes are append-only events: active, dismissed, superseded, and converted. Creation never
creates a proposal. Only an explicit eligible-finding workflow may derive a fixed-target task proposal.
Backfill is deterministic, idempotent, and performs no model work.
