# Life OS 0.1.0 release readiness

## Release definition

Version 0.1.0 is a single-user, local macOS alpha. It proves one safe daily loop:

```text
configure -> refresh -> process changed input -> review attention
          -> discuss -> propose -> confirm -> apply -> receipt -> undo
```

The vault remains canonical. Gmail, Calendar, Messages, and Telegram remain read-only. The release does
not promise background automation, provider writes, Telegram extraction, a connected iPhone client, or
multi-user hosting.

Do not create the `v0.1.0` tag until every blocking gate below is checked on a clean machine or clean
macOS user account.

## Current baseline

Implemented and automated:

- deterministic provider ingestion and replay;
- bounded Gmail and Messages extraction through the subscription host;
- validated findings, relations, attention projections, and contextual discussion;
- handled state and structured quality feedback;
- typed, stale-safe, approval-gated vault effects with backup and undo;
- sanitized browser projections and a read-only chat tool boundary;
- full TypeScript tests, UI checks, production build, and Presidio smoke verification.

The core daily loop now runs end to end in the product. Setup, runtime hardening, clean-machine
acceptance, privacy coverage, and release policy remain product blockers.

## Blocking product gates

### 1. Process new input from the product

- [x] Replace the ingestion-only Refresh action with a durable user-triggered run.
- [x] Run provider ingestion, bounded extraction, and deterministic post-extraction projection as
  separate observable stages.
- [x] Show queued, running, completed, partial, and failed status without exposing provider identifiers
  or source text.
- [x] Support bounded work retries and cooperative cancellation without retrying a poison item in a loop.
- [x] Make unchanged refreshes perform zero duplicate model work.
- [x] Prevent concurrent browser runs from leasing the same work.

The HTTP request must not stay open for an entire extraction batch. Start a bounded operational job,
poll its sanitized status, and allow the existing work leases to enforce concurrency.

Implemented with the existing metadata-only `workflow_state` and `runs` tables, so this gate does not
require a schema reset. A browser reload reconnects to the active server job; an abandoned active record
becomes explicitly `interrupted` before a later replacement run.

### 2. Complete an action in the product

- [x] Make eligible attention items offer one narrow **Create task** proposal action.
- [x] Show the exact sanitized task preview under **Approvals**.
- [x] Implement separate prepare and confirm gestures using a short-lived capability bound to the exact
  proposal, action, plan, and target hash.
- [x] Apply only through the existing typed effect executor; accept no browser-supplied path, patch, task
  text, or arbitrary arguments.
- [x] Emit a sanitized Activity receipt after application.
- [x] Offer separately prepared undo and reject undo after target drift.
- [x] Surface stale, expired, denied, and already-consumed states in plain language.

Chat remains read-only. It may explain or recommend an action, but it must never become a mutation
backdoor.

Browser mutations accept only opaque presentation identities, one-use confirmation identities, and a
session-bound CSRF capability. Internal proposal/action IDs, authorization tokens, task text, target
paths, plans, and hashes remain server-side. If a task preview contains private identifiers or
source-like material, it is not eligible for browser application and remains a private CLI review.

### 3. Make setup and operation product-grade

- [x] Add documented root commands that start development and production UI servers on `127.0.0.1`.
- [ ] Add an onboarding/setup screen driven by sanitized doctor results.
- [ ] Explain missing OAuth, Full Disk Access, policy, vault, database, Codex login, and 1Password state
  without printing resolved secrets or private source data.
- [ ] Provide a deliberate operational-state reset command that never deletes the vault.
- [ ] Verify a clean install, first provider authorization, first refresh, and first useful Inbox item.

### 4. Harden the local web boundary

- [ ] Add a Content Security Policy and explicit security headers.
- [ ] Reject non-loopback production binding unless the user makes a deliberate supported choice.
- [ ] Retain same-origin and capability checks for every state-changing route.
- [ ] Add browser-response privacy assertions for every page and API route.
- [ ] Complete keyboard, screen-reader, mobile viewport, and failure-state checks.

### 5. Finish release governance

- [x] Align TypeScript, Python, MCP, and UI versions at 0.1.0.
- [x] Add a top-level changelog.
- [x] Add a reproducible `bun run release:check`.
- [x] Add CI for the release check.
- [ ] Choose a license or explicit proprietary-use notice for the public repository.
- [ ] Freeze release notes after the end-to-end gates pass.
- [ ] Create and push an annotated `v0.1.0` tag only from a clean, verified `main`.
- [ ] Publish a GitHub release from that tag.

## Manual acceptance script

Use disposable operational state and a test vault copy. Never use a fabricated provider write.

1. Install with frozen locks and run `bun run release:check`.
2. Configure the vault and at least one read-only provider using an external mode-600 environment file.
3. Run doctor; require zero errors.
4. Trigger one product refresh and observe ingest, extraction, and projection complete.
5. Trigger an unchanged refresh; require zero duplicate records and zero duplicate model work.
6. Open one attention item and verify the discussion gives a grounded assessment and concrete next step.
7. Mark one irrelevant item and one handled item; verify both remain absent after reload.
8. Create one fixed-Inbox task proposal from an eligible finding.
9. Review, confirm, and apply it in the browser; verify the exact task appears once in the vault.
10. Undo it in the browser; verify the vault returns to its prior content.
11. Confirm Gmail, Calendar, Messages, and Telegram were not mutated.
12. Inspect browser and operational projections for raw provider text, identifiers, hashes, headers,
    addresses, credentials, or arbitrary paths.

## Release commands

After every blocking gate is complete:

```bash
bun install --frozen-lockfile
bun install --cwd "$PWD/ui" --frozen-lockfile
uv sync --frozen
bun run release:check
git diff --check
git status --short
git tag -a v0.1.0 -m "Life OS 0.1.0"
git push origin main v0.1.0
```

Tagging and publishing are intentionally manual because they are irreversible external release actions.
