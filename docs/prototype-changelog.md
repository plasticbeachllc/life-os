# Prototype changelog

Breaking changes are intentional before the first stable release.

- Schema 24: reviewed canonical subject links connect source-event containers without content- or
  timing-based inference.
- Schema 19: sanitized operational workspace feedback and opaque UI subjects.
- Schema 18: typed effect plans replace string tool names and generic argument blobs.
- Schema 17: durable extraction work, projection provenance, subject links, and common findings converged.
- Removed `life_os_propose_email_task` and the email-task executor. Task proposals originate from eligible
  common findings.
- Provider-specific pending extraction selectors were replaced by leased work subjects.
- CLI provider status/ingestion now uses the normalized integration envelope and bounded registry limits.
- Incompatible prototype databases require explicit deletion and deterministic rebuild; no compatibility
  migrations or automatic deletion are provided.
