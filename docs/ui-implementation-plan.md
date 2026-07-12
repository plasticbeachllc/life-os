# LifeOS Inbox and Chat UI Implementation Plan

## Product principle

LifeOS begins as two connected surfaces:

- **Inbox** reports what LifeOS handled, asks for clarification when evidence is ambiguous, and reserves
  approvals for sensitive or outside-world actions.
- **Chat** lets the user understand, refine, or undo internal organization and review proposed external
  actions.

The UI must preserve the existing distinction between model reasoning, deterministic state, proposals,
and authorized mutations. The target interaction policy is **act, inform, undo** for deterministic,
reversible internal organization and **propose, review, confirm** for sensitive, destructive, or
externally visible actions. Chat text never directly changes the vault or a provider.

## Initial scope

The first implementation is a responsive SvelteKit application in `ui/` using Svelte 5, Tailwind CSS,
and checked-in shadcn-svelte components. It includes:

- a desktop split view with Inbox and Chat visible together;
- mobile Inbox and Chat tabs;
- For you, Activity, Approvals, and All notification filters;
- distinct receipt, clarification, and external-proposal cards;
- selected-notification context and local lifecycle behavior;
- a ChatGPT-authenticated Codex App Server chat composer with streamed text;
- an automatic-work receipt and a separately labeled external-action proposal;
- live connection and read-only status indicators.

The browser deliberately receives no credentials, SQLite access, MCP access, arbitrary tool surface, or
raw provider content. This slice reads SQLite on the SvelteKit server and permits model calls through a
server-owned Codex App Server process. It excludes provider mutation, proposal authorization, and vault
mutation.

## Frontend architecture

```text
ui/src/routes/+page.svelte
  -> NotificationInbox.svelte
  -> ChatPanel.svelte
  -> SvelteKit page server -> sanitized notification compiler -> SQLite
  -> SvelteKit NDJSON route -> Codex App Server stdio -> read-only LifeOS MCP tools
  -> checked-in shadcn-svelte primitives
```

Application-specific components live under `ui/src/lib/life-os/`. Generated shadcn-svelte primitives
live under `ui/src/lib/components/ui/` and should remain generic. Shared UI contracts live in
`ui/src/lib/life-os/types.ts`.

The `ui/` package has its own Bun lockfile so frontend dependency changes do not modify the backend
runtime lockfile.

## UI contracts

### Notification

A notification exposes only a stable UI ID, category, tone, kind, lifecycle status, concise title,
sanitized summary, relative time, and narrow actions. It does not expose provider message IDs,
addresses, headers, subjects, source hashes, raw excerpts, or arbitrary paths.

Categories in the prototype are:

- `for_you` for ambiguity or a decision LifeOS cannot safely infer;
- `activity` for automatic internal work and routine updates;
- `approvals` for sensitive or outside-world proposals.

Presentation tones are `question`, `receipt`, `proposal`, and `update`. Lifecycle is separately tracked
as `open` or `resolved` so visual importance is not confused with completion state.

Read state and resolved state should remain separate when persistence is added.

### Chat message

A message has a stable UI ID, `user` or `agent` role, body, display timestamp, and optional structured
receipt or proposal artifact. Rendered model output is text, not trusted HTML.

### Proposal presentation

The prototype renders internal automation as **Automatic / Reversible** and external actions as
**External action / Approval required**. A connected proposal must show sanitized workflow, exact
preview, fixed destination, lifecycle state, and stale-state result from the existing proposal services.
The browser must never construct a path, patch, action ID, task ID, or confirmation token.

## Target autonomy policy

| Action class | Examples | Interaction |
| --- | --- | --- |
| Deterministic, internal, reversible | Create a task from a high-confidence owned email commitment; organize derived state | Act automatically, emit receipt, offer undo |
| Ambiguous | Unclear owner, date, project, or conflicting evidence | Ask for clarification |
| Sensitive or destructive internal | Delete canonical data, merge entities, rewrite human prose, bulk changes | Propose and confirm |
| Outside world | Send email, message a person, create or modify an external calendar event | Propose, review exact effect, confirm |

Automatic task creation still requires eligible extraction kind, user ownership, confidence policy,
stable identity, fixed destination, idempotency, current source and target hashes, an atomic write,
external backup, audit receipt, and bounded undo. Failure of any check produces a clarification or
error notification rather than a write.

This target policy is intentionally different from the repository's current non-negotiable invariant
that all vault mutations require explicit approval. The UI prototype expresses the desired product
direction, but backend automation must not be enabled until that invariant, authorization policy,
schema lifecycle, tests, and repository guidance are deliberately revised together.

## Backend integration design

Add a narrow SvelteKit server adapter only after the UI contract is accepted. It should call existing
LifeOS workflow functions on the server; the browser must not read SQLite or launch MCP tools directly.

Planned narrow endpoints:

| Endpoint | Purpose | Mutation |
| --- | --- | --- |
| `GET /api/inbox` | Return sanitized notification projections | No |
| `POST /api/inbox/:id/dismiss` | Resolve one known notification ID | Metadata only |
| `POST /api/activity/:id/prepare-undo` | Prepare undo for one known automatic internal action | Token only |
| `POST /api/activity/:id/undo` | Undo the exact internal action represented by a receipt | Approval policy TBD |
| `GET /api/proposals/:id` | Return one sanitized exact proposal preview | No |
| `POST /api/proposals/:id/prepare` | Revalidate and prepare exact approval | Token only |
| `POST /api/proposals/:id/apply` | Apply the exact prepared action | Approval-gated |
| `POST /api/actions/:id/prepare-undo` | Prepare undo for one known action | Token only |
| `POST /api/actions/:id/undo` | Consume exact undo authorization | Approval-gated |

Every mutation route needs same-origin enforcement, CSRF protection, narrow schema validation, and the
existing policy/hash checks after request validation. Responses must be sanitized projections, not raw
database rows.

### Notification projection

Notifications should be deterministically derived from existing compact state, automatic-action
receipts, pending external proposals, sanitized extraction reviews, and health status. Persisting
read/resolved state and automatic-action identity will require an additive schema migration with one
coordinated schema owner. Do not change `src/db/schema.ts` until that owner is designated.

### Subscription-host chat transport

LifeOS does not use an OpenAI API key. Chat is implemented through the locally installed Codex App
Server using its existing ChatGPT-managed login. The SvelteKit server owns the stdio JSON-RPC process,
while the browser receives only bounded NDJSON agent-message deltas and sanitized errors.

The bridge:

1. accepts a bounded user turn and optional sanitized notification title/summary;
2. starts a session-scoped ephemeral LifeOS thread in a read-only sandbox;
3. disables shell, web search, and multi-agent tools;
4. applies a fixed read-only LifeOS MCP allowlist and explicit mutation denylist;
5. rejects unsupported server-initiated requests;
6. streams agent-message deltas without exposing App Server or ChatGPT credentials.

Codex App Server remains an experimental surface. LifeOS records the runtime-reported user agent, keeps
the protocol behind one adapter, and provides `bun run codex:schema` to regenerate exact bindings when
the installed CLI changes.

## Delivery phases

### Phase 0 — UI shell (implemented)

- Scaffold SvelteKit with Bun and Tailwind CSS.
- Initialize shadcn-svelte with the neutral Nova preset.
- Add the minimal component set.
- Build responsive Inbox and Chat interactions.
- Document backend and host constraints.

### Phase 1 — Live read-only Inbox and Chat (implemented)

- Compile deterministic sanitized notifications from current operational state.
- Load notifications through SvelteKit server data without exposing SQLite to the browser.
- Connect chat through Codex App Server stdio with ChatGPT-managed authentication.
- Stream bounded agent text through a narrow NDJSON endpoint.
- Add loading, empty, degraded, and provider-disabled states.
- Verify raw provider data and hashes never reach browser payloads.

### Phase 2 — Autonomy policy and notification lifecycle

- Deliberately revise the vault-mutation invariant and repository guidance if automatic canonical task
  writes remain the chosen policy.
- Define confidence, ownership, eligible-kind, fixed-target, and reversibility requirements.
- Coordinate one additive schema migration for read, resolved, and snoozed state.
- Implement narrow ID-only lifecycle functions.
- Add optimistic UI with server reconciliation.
- Test unchanged replay and stable notification identity.

### Phase 3 — Automatic internal task receipts

- Add a deterministic, idempotent automatic email-to-task workflow behind the revised policy.
- Reuse atomic write, backup, audit, source/target hash, and undo protections.
- Emit sanitized Activity receipts containing stable internal action references.
- Route low-confidence, ambiguous, or ineligible extraction items to For you without mutation.
- Test changed-thread invalidation, duplicate suppression, failure receipts, and undo drift rejection.

### Phase 4 — External proposal review

- Connect pending proposal and exact review projections.
- Implement prepare/confirm/apply as separate user gestures.
- Reject expired tokens and stale source or target state visibly.
- Add success receipts and separately prepared undo.

### Phase 5 — Live chat transport

- Complete the subscription-host relay spike.
- Define bounded conversation and context manifests.
- Connect streaming only if the supported host transport preserves auditing and cancellation.
- Render structured proposal references without accepting model-supplied mutation arguments.

### Phase 6 — Hardening

- Add keyboard and screen-reader navigation checks.
- Add mobile browser coverage and viewport regression tests.
- Add Content Security Policy, CSRF protection, and local-bind defaults.
- Add privacy assertions for every browser response.
- Add failure telemetry containing IDs and classifications only, never raw source text.

## Verification strategy

For every UI change:

```bash
cd ui
bun run check
bun test
bun run build
```

For repository handoff:

```bash
bun run typecheck
bun test
git diff --check
```

Connected phases also need tests for sanitized payloads, stale proposal rejection, exact approval-token
binding, notification idempotency, and absence of raw Gmail bodies or provider identifiers.

## MVP acceptance criteria

- Desktop shows Inbox and Chat simultaneously without horizontal overflow at 768px and wider.
- Mobile provides two clear tabs and carries selected notification context into Chat.
- Filters are keyboard operable and expose pressed state.
- Chat input supports Enter to send and Shift+Enter for a new line.
- Automatic receipts, ambiguity, and external approvals are visually and semantically distinct.
- Live/read-only state and the absence of connected writes are unmistakable.
- No UI route can mutate the vault, Gmail, or Calendar in the initial slice.
- Frontend checks and production build pass under Bun.
