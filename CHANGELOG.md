# Changelog

All notable changes to Life OS are documented here. The project uses semantic versioning for product
releases; operational database schemas remain explicit prototype reset boundaries.

## [0.1.0] - Unreleased

### Added

- Local-first Obsidian knowledge projections with SQLite operational state.
- Read-only Gmail, Google Calendar, macOS Messages, and Telegram ingestion.
- Subscription-authenticated, evidence-validated Gmail and Messages extraction.
- Provider-independent findings, attention routing, and bounded contextual discussion.
- A responsive local Inbox and Chat UI with refresh, handled state, and structured quality feedback.
- Approval-gated typed vault effects with exact authorization, atomic writes, backups, and undo.
- Release checks covering TypeScript, UI, production build, and the Presidio privacy harness.

### Security and privacy

- Provider content is treated as untrusted evidence and is excluded from durable manifests and browser
  projections.
- Gmail and Calendar permissions remain read-only.
- Models have no arbitrary shell, path, SQL, patch, or filesystem-write capability.
- Vault mutations remain bound to an exact reviewed proposal and short-lived confirmation token.

### Blocking before release

- Complete the browser input-processing loop from refresh through bounded extraction and projection.
- Complete the browser action loop from attention item through proposal review, confirm, apply, receipt,
  and undo.
- Finish the onboarding, local-runtime hardening, and clean-machine acceptance gates in
  [`docs/release-0.1.0.md`](docs/release-0.1.0.md).
- Choose and add a license or an explicit proprietary-use notice before publishing the first release
  from this public repository.
