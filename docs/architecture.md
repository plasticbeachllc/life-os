# Life OS Architecture

- Status: target architecture and implementation specification
- Audience: maintainers, integration authors, workflow authors, UI authors, and implementation agents
- Runtime: Bun and TypeScript; Python only through uv-managed harnesses
- Canonical knowledge: Obsidian Markdown
- Operational state: SQLite outside the vault
- Reasoning transport: subscription-authenticated host agent through MCP

## 1. Purpose

Life OS is a local-first personal chief-of-staff system. It observes explicitly configured personal
information sources, converts changed information into bounded and provenance-bearing structured
findings, maintains regenerable operational projections, and proposes narrowly defined actions for
human review.

The system is not an autonomous general-purpose computer operator. It does not grant a model arbitrary
filesystem access, SQL, shell execution, provider mutation, or control over action payloads. Models
interpret bounded untrusted context; deterministic code owns selection, identity, validation, policy,
authorization, persistence, and effects.

This document has four goals:

1. State the product and technical vision.
2. Define the target architecture and its safety properties.
3. Provide reference contracts and implementation patterns.
4. Give downstream agents an ordered checklist with ownership and acceptance criteria.

The architecture is intentionally evolutionary, but the current implementation is an early prototype.
Operational schemas and internal APIs may be replaced outright while the model is still forming.
Shared lifecycle semantics should be introduced before storage is consolidated.

## 2. How to read this document

The words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative.

- **Current** describes behavior present in the repository at the time this document was written.
- **Target** describes the intended stable architecture.
- **Reference** code illustrates contracts and ownership. It is not a drop-in patch and may omit
  imports, migrations, error classes, or provider-specific details.
- **Future** describes an allowed direction, not authorization to broaden permissions now.

When this document conflicts with `AGENTS.md`, the stricter safety rule applies. A deliberate change to
a non-negotiable invariant requires explicit user approval and coordinated updates to both documents.

## 3. Vision

Life OS should answer four questions reliably:

1. **What changed?** Detect meaningful changes without reprocessing unchanged source material.
2. **What does it mean?** Extract source-grounded commitments, requests, dates, decisions, and updates.
3. **What deserves attention?** Build a compact, explainable view of open loops and near-term priorities.
4. **What should happen next?** Offer reviewable proposals whose exact effects are determined and
   constrained by code.

The desired user experience is organized around four nouns:

- **Sources** are observations from the vault and configured providers.
- **Findings** are structured interpretations supported by source evidence.
- **State** is the current compact operational understanding derived from canonical inputs.
- **Proposals** are exact possible effects awaiting authorization.

Hashes, manifests, model calls, retrieval levels, and provider cursors remain visible in audit and
diagnostic surfaces, but they are implementation concepts rather than the everyday product model.

### 3.1 Product principles

1. **Local and inspectable by default.** Canonical knowledge stays human-readable. Operational data
   stays queryable and disposable.
2. **Deterministic before probabilistic.** Code filters, normalizes, hashes, deduplicates, validates,
   and authorizes. Models handle ambiguity and synthesis only where useful.
3. **Deltas over repeated scans.** Unchanged inputs cause no duplicate findings and no model work.
4. **Evidence over confidence theater.** Every actionable finding and recommendation points to
   allowlisted evidence.
5. **Proposal before effect.** Reasoning cannot directly mutate canonical knowledge or a provider.
6. **Fail closed.** Stale inputs, missing policy, unknown schemas, and ambiguous authorization reject
   work rather than weakening a boundary.
7. **Regenerable compression.** Compact state can always be rebuilt from canonical sources and
   accepted structured records.
8. **Progressive disclosure.** Most reasoning uses metadata and compact state; raw source retrieval is
   bounded, transient, and justified.

### 3.2 Non-goals

Life OS is not intended to be:

- a general shell or filesystem agent;
- a second canonical knowledge store competing with Obsidian;
- an archive of complete email, message, or provider payloads;
- a universal workflow language driven by arbitrary JSON;
- a vector database over the entire vault and every provider body;
- an autonomous entity-merging or journal-rewriting system;
- a hidden background actor that changes external services without review;
- an API-key-based model service.

## 4. System context and trust boundaries

```text
                         trusted deterministic boundary
  ┌─────────────────────────────────────────────────────────────────────┐
  │                                                                     │
  │  Provider adapters              Operational kernel                  │
  │  ─────────────────              ──────────────────                  │
  │  Gmail readonly ─┐              source versions                     │
  │  Calendar ro ────┼─ normalize → deltas/work items                   │
  │  Messages ro ────┼─ hash      → context manifests                  │
  │  Telegram ro ────┤              findings/projections               │
  │  Obsidian read ──┘              proposals/audit/undo                │
  │                                      │                              │
  │                                      │ bounded MCP prepare           │
  └──────────────────────────────────────┼──────────────────────────────┘
                                         ▼
                              subscription host agent
                              untrusted reasoning output
                                         │
                                         │ schema-bound submit
                                         ▼
  ┌─────────────────────────────────────────────────────────────────────┐
  │ revalidate identities → validate evidence → persist derived data    │
  │ → compile policy → review → exact authorization → narrow executor   │
  └─────────────────────────────────────────────────────────────────────┘
                                         │
                                         ▼
                              canonical/effect boundary
                       Obsidian atomic writes; future approved effects
```

### 4.1 Trust classification

| Component or data | Trust treatment |
| --- | --- |
| Repository code and fixed configuration schema | Trusted deterministic control plane |
| Provider source content | Untrusted data, even when authored by the user |
| Vault prose | Canonical user knowledge, but untrusted as model instructions |
| Model output | Untrusted structured candidate until validated |
| SQLite operational records | Trusted only after validation; still subject to version checks |
| MCP arguments | Untrusted input constrained by narrow schemas |
| Policy file | Canonical authorization input; absence or invalidity fails closed |
| Authorization token | Short-lived capability bound to exact action and hashes |
| Credentials | External secret material; never repository or model context |

### 4.2 Fundamental data boundary

Obsidian Markdown is canonical for durable user knowledge and human-authored material. SQLite stores
operational facts needed to run the system:

- hashes, cursors, immutable source versions, and change events;
- prepared reasoning runs and sanitized context manifests;
- structured findings and their provenance;
- regenerable projections;
- model usage, cache identities, and workflow diagnostics;
- proposals, approvals, action results, backups, and undo metadata.

Deleting SQLite may lose operational history and pending work, but it MUST NOT destroy the only copy of
canonical user knowledge. Provider bodies MUST NOT be retained unless an integration specification
explicitly permits it. Gmail bodies are forbidden.

## 5. Target architecture

```text
providers
   │
   ▼
[1] synchronize sources
select → normalize → hash → version → emit delta
   │
   ▼
source artifacts and immutable versions
   │
   ├───────────────┐
   ▼               ▼
[2] deterministic  work queue
projections        workflow + subject + invalidation identity
   │               │
   │               ▼
   │          [3] prepared reasoning
   │          select → refetch → redact → budget → manifest
   │               │
   │               ▼
   │          host reasoning through MCP
   │               │
   │               ▼
   │          revalidate → schema/evidence validation
   │               │
   └───────────────┼───────────────┐
                   ▼               ▼
             structured findings  completed work identity
                   │
                   ▼
             [4] projections
       tasks · people · projects · schedule · open loops
                   │
                   ▼
             [5] proposals
       deterministic effect plan → review → authorization
                   │
                   ▼
             [6] effect executor
          atomic write → audit → backup → undo
```

The layers are deliberately one-way. Provider content cannot jump directly to a prompt, model output
cannot jump directly to a projection without validation, and a finding cannot jump directly to an
effect.

### 5.1 Layer responsibilities

| Layer | Owns | Does not own |
| --- | --- | --- |
| Provider adapter | Narrow provider access, fixed selection, exact refetch | Model prompts, policy, proposals |
| Normalizer | Stable sanitized representation and hashes | Provider mutation, inference |
| Source store | Current metadata, immutable versions, cursors, deltas | Raw forbidden bodies, reasoning |
| Work queue | Pending workflow subjects and invalidation identity | Arbitrary jobs or commands |
| Context builder | Ranking, budgets, omissions, manifest identity | Fetching arbitrary sources, prompting |
| Reasoning coordinator | Prepare/submit lifecycle and common audit | Provider evidence semantics, effects |
| Workflow definition | Selection, prompt contract, evidence and output validation | Generic call persistence, authorization |
| Findings store | Validated semantic records with provenance | Canonical prose, automatic action |
| Projection builder | Regenerable compact state | Untraceable summaries, side effects |
| Proposal planner | Deterministic exact action plan and review | Applying the action |
| Policy/authorization | Allow/deny, hash binding, approval capabilities | Interpreting provider prose |
| Effect executor | One narrow mutation, atomicity, audit, undo | Choosing goals, paths, patches, or commands |
| MCP/CLI/UI | Sanitized application boundary | Raw database access or bypasses |

## 6. Core domain model

The target architecture standardizes lifecycle semantics without forcing all providers into one table.
Provider-specific storage MAY remain when retention, indexing, or query shapes differ.

### 6.1 Source artifact

A source artifact is an observed unit with a stable internal identity and immutable content versions.
Examples include a Gmail message, an iMessage turn, a Telegram message, a Calendar event instance, and
an Obsidian file or relevant section.

Required properties:

- Provider selection is deterministic and narrow.
- Internal IDs are stable and do not expose provider identifiers to review surfaces.
- A normalized content hash changes if and only if modeled source meaning changes.
- Relationship or container state has a separate hash when relevant, such as a thread or conversation.
- Historical versions are immutable.
- Current records contain only retention-approved fields.
- Exact refetch verifies the current provider content against the ingested identity.

Reference contract:

```ts
export type ProviderId = "obsidian" | "gmail" | "calendar" | "imessage" | "telegram";

export interface SourceIdentity {
  provider: ProviderId;
  sourceId: string;       // configured account/database/vault identity
  artifactId: string;     // stable internal, non-provider-facing ID
  versionHash: string;    // hash of normalized retained/refetch-verifiable content
  containerId?: string;   // internal thread/conversation/calendar grouping
  containerHash?: string; // invalidates multi-artifact interpretation
}

export interface SourceArtifactMetadata extends SourceIdentity {
  occurredAt?: string;
  observedAt: string;
  availability: "metadata_only" | "refetchable" | "unavailable";
  direction?: "incoming" | "outgoing" | "system" | "unknown";
  deleted?: boolean;
}

export interface SourceDelta {
  identity: SourceIdentity;
  previousVersionHash?: string;
  kind: "created" | "changed" | "deleted" | "became_unavailable";
  changedAt: string;
}
```

`SourceIdentity` is a logical cross-provider envelope. It does not authorize a generic provider lookup
tool and does not require provider IDs to be stored in generic review tables.

### 6.2 Work item

A work item represents a deterministic conclusion that a specific workflow should process a specific
immutable subject. It is an internal attention queue, not a general task runner.

```ts
export interface WorkItem {
  workId: string;
  workflow: string;
  subjectType: "artifact" | "container" | "projection_set";
  subjectId: string;
  sourceIdentities: SourceIdentity[];
  reason: "source_delta" | "dependency_invalidated" | "manual_retry";
  priority: number;
  invalidationKey: string;
  state: "pending" | "leased" | "prepared" | "completed" | "stale" | "failed";
  attempts: number;
  availableAt: string;
  createdAt: string;
  updatedAt: string;
}
```

Normative behavior:

- `invalidationKey` MUST include workflow, subject, relevant immutable inputs, prompt/schema/policy
  versions, and deterministic builder versions.
- Replaying an unchanged source MUST NOT create a second active work item.
- A changed container hash MUST invalidate interpretation that depends on the container.
- Leases MUST expire and be recoverable after process termination.
- Failures MUST be categorized and bounded; permanent schema or permission failures MUST NOT retry in a
  tight loop.
- Work items MUST NOT contain source bodies, credentials, arbitrary commands, or effect payloads.

The work queue should be introduced only after extracting common semantics from at least two existing
workflows. It must solve observed lifecycle duplication, not become a speculative job framework.

### 6.3 Reasoning run

A reasoning run is the transport-independent state machine for model-backed work. The subscription
host prepare/submit protocol is the primary transport.

```text
created → prepared → submitted → validating → completed
   │          │           │            │
   └──────────┴───────────┴────────────┴──→ failed
              └───────────────────────────→ stale
              └───────────────────────────→ expired
```

State requirements:

| State | Required facts | Allowed next states |
| --- | --- | --- |
| `created` | Workflow and immutable input identity | `prepared`, `failed` |
| `prepared` | Prompt/schema/policy versions, sanitized manifest, context hash | `submitted`, `stale`, `expired`, `failed` |
| `submitted` | Candidate output and usage when available | `validating`, `failed` |
| `validating` | Rechecked current source/context identity | `completed`, `stale`, `failed` |
| `completed` | Validated derived record and audit linkage | Terminal |
| `stale` | Recorded identity mismatch category | Terminal; create fresh work separately |
| `expired` | Preparation exceeded bounded lifetime | Terminal |
| `failed` | Sanitized error category | Terminal or explicit bounded retry |

The architectural center is this lifecycle, not a direct `ModelAdapter.complete()` method. A future
direct transport MAY implement the same lifecycle, but MUST NOT bypass manifests or validation.

### 6.4 Finding

A finding is a validated source-grounded semantic observation. Findings allow downstream state and
proposals to depend on meaning rather than provider-specific extraction tables.

```ts
export const findingKinds = [
  "explicit_request",
  "user_commitment",
  "other_commitment",
  "decision",
  "cancellation",
  "reschedule",
  "acceptance",
  "refusal",
  "supersession",
  "date",
  "relationship_update",
  "project_update",
  "open_loop",
] as const;

export interface FindingEvidence {
  artifactId: string;       // internal identity
  versionHash: string;
  role: "delta" | "context";
}

export interface Finding {
  findingId: string;
  kind: typeof findingKinds[number];
  statement: string;
  owner: "user" | "other" | "shared" | "unknown";
  dueDate: string | null;
  confidence: number;
  ambiguities: string[];
  evidence: FindingEvidence[];
  workflow: string;
  reasoningRunId: string;
  status: "active" | "superseded" | "dismissed" | "converted";
  createdAt: string;
}
```

Normative behavior:

- Every finding MUST cite at least one allowed evidence version.
- Delta workflows MUST require at least one `delta` evidence item per new finding.
- Statements MUST be bounded and source-grounded; they MUST NOT contain raw retained excerpts merely
  for audit convenience.
- Findings MUST be immutable. Lifecycle changes are separate status or supersession records.
- Provider-specific extraction output MAY contain additional fields, but its cross-provider projection
  MUST conform to the finding envelope.
- A finding MUST NOT automatically create a canonical task, calendar event, message, or provider
  mutation.
- Reviews MUST replace internal/provider identifiers with sanitized display data.

### 6.5 Projection

A projection is a disposable materialized view over canonical sources and validated findings.

```ts
export interface Projection<T> {
  projectionId: string;
  projectionType: string;
  entityId?: string;
  version: number;
  value: T;
  inputs: Array<{
    type: "source" | "finding" | "projection";
    id: string;
    version: string;
  }>;
  builderVersion: string;
  generationMethod: "deterministic" | "validated_reasoning";
  createdAt: string;
  supersededAt?: string;
}
```

Projection families include:

- task state;
- project state;
- person and relationship state;
- schedule/calendar state;
- open-loop and commitment state;
- chief-of-staff state;
- morning briefing inputs.

Projection requirements:

- Input provenance and builder version MUST be sufficient to reproduce or invalidate a projection.
- Current projection replacement MUST be transactional.
- Rebuilds over unchanged inputs SHOULD yield the same semantic content hash.
- Recursive compression MUST have bounded depth and canonical links.
- A model-generated narrative MUST NOT silently replace deterministic state.
- Morning briefings SHOULD present projections and bounded recommendations rather than become a
  separate knowledge store.

### 6.6 Proposal, effect plan, and action

A proposal is an exact, inspectable, immutable plan for a possible effect. The model may identify a
finding worth acting on, but deterministic code constructs the effect plan.

```ts
export type EffectPlan =
  | { type: "frontmatter_patch"; additions: Record<string, string> }
  | { type: "task_id_patch"; patches: TaskIdPatch[] }
  | { type: "policy_bootstrap"; content: string; sourcePath?: string }
  | { type: "finding_task_append"; findingId: string; taskId: string; taskLine: string };

export interface Proposal {
  proposalId: string;
  effectType: EffectPlan["type"];
  effectPlan: EffectPlan;
  effectPlanHash: string;
  executorVersion: string;
  source: { type: string; id: string; hash: string };
  target: { relativePath: string; expectedHash: string };
  state: "pending" | "approved" | "rejected" | "expired" | "applied" | "stale";
  createdAt: string;
  expiresAt?: string;
}
```

The plan hash covers the validated plan, executor version, source identity/hash, and target path/hash.
Executor selection is derived from the discriminant through a closed code registry; it is never stored
as caller-controlled data. Reviews are projections produced by the registered executor, not persisted
prompt blobs or generic argument rendering.

Proposal lifecycle:

```text
validated finding or deterministic need
  → deterministic plan
  → policy compilation
  → pending proposal
  → sanitized review
  → short-lived authorization bound to proposal + action + hashes
  → recheck policy and source/target state
  → narrow executor
  → atomic effect + action result + backup/undo
```

Proposal requirements:

- The caller MUST NOT supply an arbitrary path, patch, task body, command, URL, SQL, or executor.
- Each proposal type MUST derive its target and effect arguments from validated records.
- The review MUST show the useful effect without leaking forbidden provenance.
- Authorization MUST be short-lived, single-use, and bound to the exact plan/action and expected
  source/target hashes.
- Apply MUST recompile policy and recheck current state after model output and after approval.
- Writes MUST be atomic and audited. Vault writes MUST create external backups and undo records.
- Undo MUST reject if the post-action target hash no longer matches.

## 7. Provider architecture

### 7.1 Provider contract

Providers share lifecycle concepts but retain narrow capabilities.

```ts
export interface ProviderCapabilities {
  ingestion: true;
  immutableVersions: true;
  transientRefetch: boolean;
  extraction: boolean;
  providerMutation: false; // version 1 invariant
}

export interface ProviderIntegration<Status, Report> {
  id: ProviderId;
  capabilities: ProviderCapabilities;
  status(): Promise<Sanitized<Status>> | Sanitized<Status>;
  ingest(input: { limit?: number }): Promise<Report>;
}
```

The common contract MUST NOT add generic methods such as `query(sql)`, `fetch(url)`, `read(path)`, or
`mutate(payload)`. Exact refetch belongs to a provider/workflow-specific internal interface and is not
automatically exposed through MCP.

### 7.2 Ingestion transaction

Every provider ingestion follows:

```text
validate configuration and permissions
  → start run
  → list using fixed provider selection
  → normalize allowed fields
  → compute stable hash
  → compare with current version
  → store changed metadata + immutable version
  → emit idempotent delta
  → advance cursor only through committed input
  → update deterministic projection where applicable
  → complete run with sanitized counts
```

If ingestion fails after a run starts, the run SHOULD reach a terminal failed state. Cursor advancement
MUST never skip uncommitted source rows. Partial failures MUST be categorized without persisting raw
provider errors that may contain private payloads.

### 7.3 Provider retention matrix

| Provider | Selection | Retained | Explicitly not retained |
| --- | --- | --- | --- |
| Obsidian | Vault root and supported Markdown shapes | Paths, hashes, parsed canonical state | Rewritten journal prose; writes outside narrow tools |
| Gmail | `IMPORTANT`, readonly account | Internal/provider identity where operationally required, timestamps, labels/state hashes, version metadata | Bodies, excerpts, raw headers, review-visible subjects/addresses |
| Messages | Configured allowlist or explicit all-except mode; fixed local DB | Internal IDs, hashes, timestamps, direction, service, counts, cursors | Text, addresses, names, attachments, attributed archives |
| Telegram | Explicit chat allowlist; bounded TDLib history | Internal IDs, hashes, timestamps, direction, cursors, availability | Message bodies and participant secrets unless separately approved |
| Calendar | Primary calendar, bounded window, readonly | Title, optional location, status, time range, all-day state, hashes | Description, attendees, organizer, conference data, attachments, raw response |

Any retention expansion requires an explicit integration specification, schema review, sanitized-output
review, and tests proving forbidden data is absent.

### 7.4 Exact refetch

Where bodies are not retained, extraction preparation MAY refetch a selected source transiently.

Exact refetch MUST:

1. Accept only an internal source identity already present in operational state.
2. Use a fixed provider query or fixed local database lookup.
3. Reapply configured provider selection.
4. Normalize and hash the fetched content identically to ingestion.
5. Reject content, participant/container, deletion, or selection drift.
6. Return text only to the bounded preparation pipeline.
7. Avoid logging, caching, or persisting the transient text.

For privacy-harness processing, text is passed through stdin. It is never placed in argv.

## 8. Context and reasoning architecture

### 8.1 Retrieval levels

| Level | Meaning | Typical content |
| --- | --- | --- |
| 0 | Metadata | Counts, timestamps, kinds, status, hashes represented as descriptors |
| 1 | Compact state | Current task/project/person/schedule/open-loop projections |
| 2 | Relevant canonical sections | Selected bounded Markdown sections or structured findings |
| 3 | Full transient source | Exact refetched provider content for explicit extraction/verification |

Level 3 retrieval MUST be justified by the workflow and MUST NOT become durable merely because it was
included in a model call.

### 8.2 Context manifest

Every model-backed workflow MUST build and record a context manifest containing:

- included sanitized audit items;
- omitted items and omission reasons;
- per-category and total token budgets;
- retrieval levels used;
- ranking/builder version;
- context hash;
- source references expressed through safe internal identities;
- escalation count where retrieval expands;
- creation and optional expiry time.

The live context returned to the host MAY contain transient source text. The persisted manifest MUST use
the workflow's audit sanitizer and MUST NOT retain forbidden text.

The context hash MUST be computed over the exact semantic live inputs required to bind submission, not
over the redacted audit projection alone. Implementations should take care not to serialize the live
context into logs while calculating it.

### 8.3 Budgeting and ranking

Context selection SHOULD rank candidates deterministically by relevance, expected impact, and recency.
It MUST:

- use stable tie-breaking;
- deduplicate semantic candidates;
- enforce category budgets;
- record why items were omitted;
- avoid filling a budget merely because space remains;
- prefer current compact projections over repeated source text;
- process changed items rather than replaying entire histories.

Token estimates may be approximate, but the estimator and ranking versions are part of invalidation.

### 8.4 Prompt specification

Prompts are code-owned versioned contracts, not workflow-local string concatenation.

```ts
export interface PromptSpec {
  workflow: string;
  version: string;
  specHash: string;
  instructions: string;
  rules: readonly string[];
  schema: Record<string, unknown>;
}
```

A compiled prompt identity MUST include the base prompt specification and deterministic policy
instructions. Changing instructions, rules, output schema, or compiled policy identity invalidates
prepared and cached work.

Provider text and vault prose MUST be clearly marked as untrusted data. Prompt instructions help the
model but do not enforce security; deterministic submission validation does.

### 8.5 Generic prepared-workflow coordinator

Email extraction, Messages extraction, and morning reasoning share a lifecycle. The target architecture
extracts that lifecycle into one coordinator while preserving provider-specific hooks.

Reference definition:

```ts
export interface PreparedWorkflow<Selection, Prepared, Output, Persisted> {
  id: string;
  taskType: string;
  prompt: PromptSpec;

  select(input: Selection): Promise<Prepared | undefined>;
  immutableIdentity(prepared: Prepared): Record<string, string>;
  buildContext(prepared: Prepared): Promise<LiveContextManifest>;
  auditContext(manifest: LiveContextManifest): PersistableContextManifest;
  evidence(manifest: LiveContextManifest): EvidenceDescriptor[];

  currentIdentity(input: Selection, prepared: Prepared): Promise<Record<string, string>>;
  validateOutput(
    output: unknown,
    evidence: EvidenceDescriptor[],
    prepared: Prepared,
  ): asserts output is Output;
  persist(output: Output, prepared: Prepared, call: ReasoningCall): Promise<Persisted>;
}
```

Reference coordinator:

```ts
export async function prepareWorkflow<S, P, O, R>(
  definition: PreparedWorkflow<S, P, O, R>,
  input: S,
  services: WorkflowServices,
): Promise<PreparedResponse | EmptyResponse> {
  const prepared = await definition.select(input);
  if (!prepared) return { empty: true };

  const identity = definition.immutableIdentity(prepared);
  const cached = services.results.find(definition.id, identity, definition.prompt.version);
  if (cached) return { cached: true, result: cached };

  const liveManifest = await definition.buildContext(prepared);
  const call = services.reasoning.prepare({
    workflow: definition.id,
    taskType: definition.taskType,
    prompt: definition.prompt,
    identity,
    contextHash: liveManifest.contextHash,
    auditManifest: definition.auditContext(liveManifest),
  });

  return {
    cached: false,
    callId: call.callId,
    identity,
    promptVersion: definition.prompt.version,
    promptSpecHash: definition.prompt.specHash,
    instructions: renderInstructions(definition.prompt, services.policy),
    schema: definition.prompt.schema,
    context: liveManifest.includedItems.map((item) => item.content),
    evidence: definition.evidence(liveManifest),
  };
}

export async function submitWorkflow<S, P, O, R>(
  definition: PreparedWorkflow<S, P, O, R>,
  input: S,
  submitted: SubmittedResponse,
  services: WorkflowServices,
): Promise<R> {
  const call = services.reasoning.requirePrepared(submitted.callId, definition.id);
  const prepared = services.preparations.require<P>(call.callId);

  assertEqualIdentity(call.identity, definition.immutableIdentity(prepared));
  assertEqualIdentity(call.identity, await definition.currentIdentity(input, prepared));
  services.policy.assertVersion(call.policyVersion);
  services.prompts.assertCurrent(call.promptVersion, call.promptSpecHash);

  const manifest = services.manifests.require(call.callId, call.contextHash);
  const evidence = definition.evidence(manifest);
  definition.validateOutput(submitted.output, evidence, prepared);

  return services.transaction(async () => {
    const result = await definition.persist(submitted.output, prepared, call);
    services.reasoning.complete(call, submitted.usage);
    services.work.complete(call.workId, call.invalidationKey);
    return result;
  });
}
```

The actual implementation MUST avoid persisting `Prepared` if it contains raw transient context.
Persist only the minimal immutable identity necessary to refetch and validate at submission.

### 8.6 Evidence validation

Evidence descriptors are generated by code. The host may only cite IDs returned during preparation.

Submission MUST validate:

- evidence ID is on the allowlist;
- evidence version matches the prepared identity;
- every actionable item cites evidence;
- delta workflows cite at least one newly changed item;
- an item cannot cite metadata that does not support its kind;
- prompt-injection flags are consistent with deterministic indicators;
- item count, string bounds, enums, confidence, dates, and ambiguity arrays match the schema.

Evidence identifiers MUST not be exposed in sanitized user review when doing so reveals provider IDs or
source hashes.

### 8.7 Cache identity

Model or reasoning result cache keys MUST include, where relevant:

```text
workflow
prompt version and specification hash
model/host reasoning identity
source version hashes
container/thread/conversation state hash
context hash
output schema version
policy version
context builder/ranking version
privacy/redaction policy version
```

Cache hits still require output validation. Invalid cached output is deleted and recomputed. A cache hit
records a call/audit event but zero new model tokens.

## 9. Operational persistence

### 9.1 Storage strategy

Use one SQLite database for transactional operational state. Split code by repository responsibility,
not into multiple databases:

- `RunRepository`
- `SourceRepository` and provider stores
- `WorkRepository`
- `ReasoningRepository`
- `ManifestRepository`
- `FindingRepository`
- `ProjectionRepository`
- `ProposalRepository`
- `AuthorizationRepository`
- `AuditRepository`

`OperationalStore` MAY remain as the database owner and schema initialization entry point while exposing these
narrow interfaces. This reduces the current broad store surface without losing cross-record
transactions.

### 9.2 Transaction boundaries

The following operations SHOULD be atomic:

- store a changed provider record, immutable version, delta, and safe cursor advancement;
- create a work item under a unique invalidation key;
- persist prepared-call metadata and its sanitized context manifest;
- persist validated findings, complete reasoning, and complete the matching work item;
- supersede an old projection and create its replacement;
- apply an effect and record the action result and undo metadata, with filesystem atomicity coordinated
  as closely as possible.

External provider reads cannot participate in SQLite transactions. Fetch first, verify, then commit a
small deterministic result. Never hold a write transaction open across network or model work.

### 9.3 Reference schema

The following illustrates target concepts. Agents MUST NOT paste it blindly into `schema.ts`.

```sql
CREATE TABLE work_items (
  work_id TEXT PRIMARY KEY,
  workflow TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  priority INTEGER NOT NULL,
  invalidation_key TEXT NOT NULL UNIQUE,
  source_identities_json TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at TEXT,
  available_at TEXT NOT NULL,
  last_error_category TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_work_items_ready
ON work_items(state, available_at, priority DESC);

CREATE TABLE findings (
  finding_id TEXT PRIMARY KEY,
  workflow TEXT NOT NULL,
  reasoning_call_id TEXT NOT NULL REFERENCES model_calls(call_id),
  kind TEXT NOT NULL,
  statement TEXT NOT NULL,
  owner TEXT NOT NULL,
  due_date TEXT,
  confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),
  ambiguities_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(workflow, content_hash)
);

CREATE TABLE finding_status_events (
  event_id TEXT PRIMARY KEY,
  finding_id TEXT NOT NULL REFERENCES findings(finding_id),
  status TEXT NOT NULL,
  related_finding_id TEXT REFERENCES findings(finding_id),
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_finding_status_events_finding
ON finding_status_events(finding_id, created_at);
```

Provider extraction tables can initially remain canonical for their extraction results, with a
deterministic projection into `findings`. Consolidation must preserve provider-specific privacy tests.

### 9.4 Prototype schema rules

- One coordinated owner controls `schemaVersion` and shared DDL.
- An operational database with a different schema version fails with an explicit reset instruction.
- Life OS never deletes or resets the database automatically.
- Developers delete the disposable operational database and rebuild from canonical Markdown and
  configured providers when the schema changes.
- Backfills within one schema version remain deterministic, bounded, idempotent, and make no model
  calls.
- No rebuild or schema revision copies forbidden source material into generic tables.
- Stable compatibility migrations become required only after the user declares the data model stable.

## 10. Policy, authorization, and effects

### 10.1 Permission classes

The system should maintain clear effect classes:

| Class | Meaning | Behavior |
| --- | --- | --- |
| Read | No external or canonical mutation | May run under narrow schema without approval |
| Prepare | Creates transient context or pending proposal | Audited; no canonical effect |
| Yellow | Reversible, narrow canonical mutation | Exact review and explicit authorization required |
| Red | Forbidden or insufficiently bounded action | Cannot be authorized |

Provider writes remain disabled in version 1 even if a provider API technically supports them.

### 10.2 Policy evaluation points

Policy MUST be evaluated:

1. Before preparing an effect proposal, to avoid presenting impossible actions.
2. After model output has been validated, never relying on prompt instructions.
3. When preparing authorization.
4. Immediately before consuming authorization/applying the effect.

The last evaluation is authoritative. A policy change invalidates older authorization.

### 10.3 Executor interface

```ts
export interface EffectExecutor<Plan extends EffectPlan, Result> {
  readonly effectType: Plan["type"];
  readonly version: string;
  readonly permissionClass: "yellow";
  readonly policyAction?: string;
  validatePlan(plan: unknown): asserts plan is Plan;
  review(plan: Plan): SanitizedProposalReview;
  assertSourceCurrent(proposal: Proposal, plan: Plan): Promise<void>;
  apply(input: BoundEffectApplication): Promise<Result>;
}
```

Executors are registered in code through an exact allowlist. MCP never accepts an executor name from a
free-form caller and never accepts generic effect arguments. Authorization is bound to both the plan
hash and executor version; a code-version change or plan mutation requires proposal regeneration.

## 11. Application surfaces

### 11.1 MCP

MCP is the primary bridge to the subscription host. Every tool MUST have:

- a narrow domain verb;
- a bounded provider/domain-specific schema;
- accurate read-only, destructive, and idempotency annotations;
- sanitized output;
- no arbitrary paths, commands, patches, URLs, SQL, or filesystem writes;
- explicit allowlist coverage in `tests/mcp-server.test.ts`.

Read-only provider status and ingestion tools MAY be generated from safe integration registrations.
Mutation and authorization tools MUST remain explicit registrations to preserve review visibility.

Recommended surface families:

```text
life_os_<provider>_status
life_os_ingest_<provider>
life_os_prepare_<workflow>
life_os_submit_<workflow>
life_os_review_<finding-family>
life_os_propose_<effect>
life_os_prepare_<effect>_approval
life_os_apply_<approved-effect>
life_os_prepare_undo
life_os_undo_action
```

A generic internal coordinator does not require a generic public `life_os_run_workflow` tool.

### 11.2 CLI

The CLI is an operator and diagnostic surface. Commands should remain provider- or domain-scoped while
sharing registration metadata for repetitive status/ingest behavior.

```text
life-os doctor
life-os state rebuild|show
life-os <provider> status|ingest
life-os <domain> review
life-os proposals list|show|approve|apply
life-os actions undo
life-os metrics efficiency
```

CLI review output obeys the same sanitization policy as MCP. A debug flag MUST NOT become a bypass for
raw forbidden content.

### 11.3 UI

The UI should expose:

- current attention/state summary;
- findings grouped by useful domain queues;
- pending proposals with exact previews;
- action results and available undo;
- provider health and stale/failed work without raw payloads;
- an optional audit drill-down showing versions and omission reasons safely.

Chat is an interaction surface, not a privileged execution path. Chat-originated actions enter the same
proposal and authorization lifecycle as CLI or MCP actions.

## 12. Privacy and security specification

### 12.1 Credentials

- Repository files MUST contain no credentials or resolved secrets.
- External environment files MAY contain `op://` references and must be mode `600`.
- `op run` resolves references only into the narrow provider process.
- Resolved credentials MUST NOT appear in argv, logs, SQLite, MCP output, model context, or exceptions.
- OAuth scopes remain the minimum required and are checked in tests where possible.
- No OpenAI API-key authentication is introduced.

### 12.2 Redaction

Stock Presidio is used for configured high-risk PII categories. Python invocations use uv and receive
text through stdin. Custom recognizers, including OTP or business-identifier logic, require explicit
user approval.

Redaction is defense in depth, not permission to retain source text. Provider retention rules still
apply after redaction.

### 12.3 Sanitized projections

User review should reveal enough meaning to decide, without revealing unnecessary source mechanics.
Sanitized reviews MUST NOT expose, unless explicitly required and approved:

- provider message/event/chat IDs;
- source or context hashes;
- raw headers, subjects, addresses, or participant identifiers;
- source excerpts or provider response fragments;
- credentials, OAuth data, local database paths, or backup paths.

Internal error messages should use categories such as `source_changed`, `selection_changed`,
`provider_unavailable`, `schema_rejected`, and `policy_denied` rather than embedding raw provider text.

### 12.4 Prompt injection

All provider and vault content is untrusted as instructions. Each extraction workflow must:

- clearly delimit content as data;
- include deterministic injection indicators where available;
- instruct the host to ignore embedded directives;
- validate the reported injection flag against deterministic indicators;
- reject output outside the schema and evidence allowlist;
- prevent any output from directly selecting or invoking an effect.

Security rests on deterministic boundaries, not the model's willingness to follow a warning.

## 13. Reliability and concurrency

### 13.1 Idempotency

Idempotency exists at each layer:

| Layer | Identity |
| --- | --- |
| Provider version | Provider/source/internal artifact/content hash |
| Delta | Source identity + new content hash |
| Work item | Workflow + subject + complete invalidation identity |
| Prepared run | Work item + prompt/schema/policy/context identity |
| Finding | Workflow + normalized semantic content + evidence versions |
| Projection | Type/entity + ordered input identities + builder version |
| Proposal | Workflow/effect + source hash + target hash + plan hash |
| Effect | Approved action ID + authorization capability |

### 13.2 Stale-state handling

Staleness is expected, not exceptional corruption. Submit and apply operations reject when any bound
identity changed. They MUST NOT silently reinterpret output against new state.

The caller may prepare fresh work after rejection. Old calls and proposals retain sanitized audit state
and become `stale`; they are never mutated into a new identity.

### 13.3 Retries

Retry categories:

- Transient provider/network failures: bounded exponential backoff.
- Process interruption: recover expired work lease and retry.
- Rate limit: respect provider delay and keep cursor unchanged.
- Source changed/stale: terminal for that preparation; enqueue new identity if still relevant.
- Schema/evidence rejection: terminal candidate failure; do not repeatedly resubmit automatically.
- Policy denied: terminal until explicit policy or action change.
- Storage/migration failure: stop affected workflow and surface operator diagnostics.

Retries MUST not duplicate findings, advance cursors past failed data, or replay an effect.

### 13.4 Time

- Store timestamps as ISO 8601 UTC unless a canonical source requires a date-only value.
- Interpret relative dates only when the workflow has an explicit reference time and timezone.
- Otherwise preserve relative dates as unresolved ambiguity.
- Tests use injected clocks for expiration, lease, briefing, and stale-state behavior.

## 14. Observability and audit

Every workflow should make these questions answerable without raw content:

- What source version triggered work?
- Why was a model call necessary?
- What retrieval levels and token budget were used?
- What was included and omitted?
- Which prompt, schema, policy, redaction, and builder versions applied?
- Was the result cached?
- Which evidence versions support a finding?
- Why did a proposal pass or fail policy?
- What exact effect occurred, and can it be undone?

Recommended metrics:

- discovered/changed/unchanged/unavailable provider records;
- deltas emitted and duplicate deltas prevented;
- pending, stale, failed, and completed work items by workflow;
- model calls avoided by unchanged replay and cache;
- input/output/cached tokens by workflow;
- context budget utilization and retrieval escalation count;
- findings accepted, dismissed, superseded, and converted;
- proposal acceptance/rejection/stale rates;
- action success, failure, and undo rates;
- median ingestion-to-finding and finding-to-review latency.

Metrics and logs MUST use sanitized labels and internal aggregate counts. They MUST NOT use provider
subjects, addresses, prose, or external IDs as metric dimensions.

## 15. Current-to-target mapping

The repository already contains most foundations. The target architecture organizes and consolidates
them rather than replacing them wholesale.

| Current area | Target role | Recommended change |
| --- | --- | --- |
| `src/adapters/` | Provider boundary | Preserve narrow adapters and exact fixed queries |
| Provider stores | Source/version persistence | Preserve provider retention; compose shared repositories |
| `src/integrations/` | Provider registration | Extend safe status/ingest metadata; do not generalize mutation |
| `change_events` | Source deltas | Normalize identity semantics before adding work queue |
| Gmail/Messages extraction workflows | Prepared reasoning | Extract common coordinator, retain provider hooks |
| `src/context/` | Context builder | Add explicit live-versus-audit manifest types and builder identity |
| `src/orchestration/` | Reasoning lifecycle | Center prepare/submit state; make direct adapter a transport option |
| Provider extraction tables | Provider results | Deterministically project into common findings initially |
| `derived_states` | Projections | Formalize builder/input identity and transactional replacement |
| Proposal/action/authorization tables | Effect lifecycle | Introduce typed effect plans without weakening existing checks |
| `OperationalStore` | DB owner | Split into narrow repository interfaces incrementally |
| `src/mcp/server.ts` | Host boundary | Generate only repetitive read-only registrations; explicit mutations |
| `src/cli.ts` | Operator surface | Share registration metadata while preserving scoped commands |

## 16. Implementation plan

This plan minimizes risky simultaneous edits. Each phase should merge independently and preserve
current behavior unless its acceptance criteria explicitly state otherwise.

### Phase 0: architectural contracts and characterization

Goal: make current behavior measurable before refactoring.

- [ ] Add architecture decision records for source identity, reasoning lifecycle, findings, projections,
  and effects.
- [ ] Characterize current Gmail and Messages prepare/submit behavior with cross-workflow tests.
- [ ] Record current retention and sanitized output fixtures.
- [ ] Record current cache and invalidation inputs per workflow.
- [ ] Document current reasoning states (`prepared`, `completed`, `failed`) and gaps.
- [ ] Add injected-clock helpers where tests currently depend on wall time.

Acceptance criteria:

- [ ] No production behavior or schema change.
- [ ] Tests prove stale source/container, prompt version, policy version, invalid evidence, and injection
  consistency rejection for both extraction workflows.
- [ ] Tests prove unchanged replay causes zero duplicate extraction/model work.

Ownership: orchestration test owner; no concurrent schema/MCP/CLI edits.

### Phase 1: shared prepared-reasoning coordinator

Goal: remove duplicated lifecycle bookkeeping while keeping provider-specific behavior.

- [ ] Define transport-independent reasoning run states and sanitized error categories.
- [ ] Define separate `LiveContextManifest` and `PersistableContextManifest` types.
- [ ] Implement the generic prepared-workflow coordinator.
- [ ] Move model-call status, manifest persistence, prompt/policy identity checks, and usage completion into
  the coordinator.
- [ ] Keep exact refetch, source selection, evidence construction, and retention sanitizers in provider
  definitions.
- [ ] Migrate Gmail extraction.
- [ ] Migrate Messages extraction.
- [ ] Migrate morning reasoning after extraction parity is proven.
- [ ] Decide whether `ModelGateway` becomes a transport implementation or a lower-level audit service;
  remove competing lifecycle ownership.

Acceptance criteria:

- [ ] Deliberate MCP and CLI removals are documented in the prototype changelog.
- [ ] Gmail and Messages retain their distinct delta/evidence validation.
- [ ] Persisted manifests contain no transient source text.
- [ ] All prepare/submit invalidation tests pass across workflows.
- [ ] No new model transport or API key is introduced.

Ownership: one orchestration owner for `src/orchestration/` and shared tests. Provider agents may prepare
definitions but should not concurrently modify the coordinator.

### Phase 2: common findings projection

Goal: let downstream state operate on semantic records rather than provider tables.

- [ ] Finalize finding enums and normalization rules from existing prompt contracts.
- [ ] Add the coordinated finding and status-event schema.
- [ ] Implement deterministic provider-extraction-to-finding projectors.
- [ ] Backfill existing Gmail and Messages extractions without model calls.
- [ ] Preserve links to provider extraction and reasoning call internally.
- [ ] Add sanitized review queries that operate on findings.
- [ ] Support dismiss, supersede, and convert as explicit lifecycle events.
- [ ] Generalize fixed-inbox task proposal from eligible extraction items to eligible findings while
  retaining deterministic text/target/ID derivation.

Acceptance criteria:

- [ ] Provider-specific retention tests still pass.
- [ ] Backfill is idempotent and resumable.
- [ ] Equivalent provider extraction replays create no duplicate findings.
- [ ] Every finding has valid evidence and at least one delta source where required.
- [ ] Finding review leaks no provider IDs, hashes, addresses, headers, or excerpts.
- [ ] Finding creation alone creates no proposal or mutation.

Ownership: one schema owner; coordinate proposal changes with the policy/effect owner.

### Phase 3: projection contract

Goal: make compact state explicitly regenerable from canonical sources and findings.

- [x] Define projection builder interface and builder-version identity.
- [x] Represent projection input provenance uniformly.
- [x] Build open-loop/commitment state from active findings.
- [x] Update chief-of-staff state to consume projections rather than provider extraction tables.
- [x] Make morning briefing a deterministic presentation over current projections.
- [x] Add bounded model recommendations as a separate overlay, never a replacement for state.
- [x] Add deterministic full rebuild and targeted invalidation paths.

Acceptance criteria:

- [x] Full rebuild from canonical sources and findings reproduces semantic state.
- [x] Unchanged rebuild produces stable content hashes and zero model calls.
- [x] Superseded/dismissed findings leave current projections correctly.
- [x] Every registered projection reports its input identities and builder version.
- [x] Human-authored journal prose remains unchanged.

Ownership: state/projection owner; coordinate context contract changes with orchestration owner.

### Phase 4: internal work queue

Goal: unify pending/invalidation/retry semantics after common workflows prove the requirements.

- [x] Define work item schema and unique invalidation key.
- [x] Add lease, expiration, retry category, and bounded attempt behavior.
- [x] Emit work from committed source deltas.
- [x] Convert extraction selection from provider-specific “next unprocessed” queries to work subjects.
- [x] Complete work transactionally with validated findings.
- [x] Add recovery for interrupted leases and explicit stale terminal state.
- [x] Add sanitized status/metrics.

Acceptance criteria:

- [x] Concurrent workers cannot process the same invalidation key twice.
- [x] Process termination recovers work after lease expiry.
- [x] Changed container/source identity makes old work stale and creates at most one new active item.
- [x] Retry never advances a provider cursor or duplicates a finding.
- [x] Work rows contain no raw source text or arbitrary executable payload.

Ownership: one schema and orchestration owner. Do not implement independently per provider.

### Phase 5: typed effect plans

Goal: make the proposal/effect boundary reusable without making it generic or permissive.

- [x] Define typed effect-plan union for currently registered proposal tools.
- [x] Add plan hash and executor version to proposal invalidation identity.
- [x] Implement explicit executor registry.
- [x] Move review projection into each typed executor.
- [x] Retain policy compilation at prepare-authorization and apply time.
- [x] Preserve short-lived single-use tokens, exact target hashes, atomic writes, backups, and undo.
- [x] Migrate existing frontmatter, task-ID, policy-bootstrap, and inbox-append actions.

Acceptance criteria:

- [x] No MCP/CLI caller can supply arbitrary path, patch, SQL, URL, command, or executor.
- [x] Existing stale target/source tests continue to reject.
- [x] Apply is idempotent per approved action.
- [x] Undo rejects a changed target.
- [x] Red actions and unknown effect types cannot be registered through data.

Implemented in schema version 18. This is intentionally a breaking prototype reset: legacy
`tool_name`/`arguments_json` action storage is replaced by validated `effect_type`, `effect_plan_json`,
`effect_plan_hash`, and `executor_version` fields. Proposal identity and authorization-token consumption
include the immutable plan hash and executor version. The CLI, MCP review, UI notifications, policy
authorization, apply router, and undo bookkeeping now consume the same typed contract.

Ownership: single policy/effect owner; no parallel authorization edits.

### Phase 6: repository interfaces and application registration

Goal: reduce large coordination hotspots after domain contracts stabilize.

- [x] Extract narrow repository interfaces from `OperationalStore` without changing the database.
- [x] Introduce transaction-scoped repository composition.
- [x] Extend integration registrations with safe CLI/MCP status and ingestion metadata.
- [x] Generate repetitive read-only status/ingestion registration.
- [x] Keep mutation, authorization, credentials, and exact refetch tools explicit.
- [ ] Split MCP tool implementations into domain modules while preserving one allowlist.
- [ ] Split CLI handlers into domain modules while preserving documented commands.

Acceptance criteria:

- [x] No circular dependency from provider stores into MCP/CLI.
- [x] All current tool names and annotations remain exact unless deliberately migrated.
- [x] MCP allowlist tests detect additions/removals.
- [x] Generated registrations cannot expose mutation-capable handlers.
- [x] Store splitting does not create multiple SQLite connections inside one required transaction.

The first Phase 6 slice adds immutable application metadata to each integration registration and uses
it to generate the four provider status/ingestion pairs for both MCP and CLI. Registration validates
the exact derived MCP names, unique CLI command ownership, and `providerMutation: false`. Generated
CLI handlers accept only `--vault` and the registration's bounded `--limit`; credentials, transient
refetch, extraction, linking, triage, policy, authorization, and mutation remain explicit handlers.

`withRepositoryTransaction` composes narrow findings, work, and prepared-reasoning repositories over
one unexposed SQLite connection and one transaction. Coordinators receive domain methods rather than
raw SQL access, and an exception rolls the entire cross-domain operation back. This is additive code
organization only; schema version 18 is unchanged.

Ownership: application-surface owner; coordinate `src/mcp/server.ts` and `src/cli.ts` as shared files.

### Phase 7: UI alignment and operational polish

Goal: expose the product model cleanly.

- [ ] Organize UI around sources, findings, state, and proposals.
- [ ] Add attention queues for reply/open-loop/date/relationship/project categories.
- [ ] Show freshness and provenance without raw identifiers.
- [ ] Show proposal previews and explicit approval state.
- [ ] Show action result and undo availability.
- [ ] Add provider health, work backlog, and sanitized failure categories.
- [ ] Add feedback capture for finding usefulness and proposal acceptance.

Acceptance criteria:

- [ ] Chat cannot bypass proposal authorization.
- [ ] UI and MCP review projections share sanitization tests.
- [ ] No provider IDs, source hashes, raw addresses, subjects, or excerpts appear in browser payloads.
- [ ] Empty, stale, loading, partial-provider, and failed states are represented.

Ownership: UI owner consuming stable domain APIs; no direct SQLite access from client code.

## 17. Cross-cutting test specification

Every integration or shared-lifecycle change must cover the applicable cases below.

### 17.1 Provider and ingestion

- [ ] Exact permission scope and configured selection.
- [ ] Fixed query/path boundaries; rejection of arbitrary inputs.
- [ ] Deterministic normalization and stable hashes.
- [ ] First ingest, unchanged replay, changed source, deletion/unavailability.
- [ ] Container/thread/conversation invalidation.
- [ ] Partial provider failure and safe cursor behavior.
- [ ] No forbidden body or provider payload retention.
- [ ] Sanitized status and error categories.

### 17.2 Context and reasoning

- [ ] Per-category and total token budgets.
- [ ] Stable ranking and deduplication.
- [ ] Included/omitted audit manifest and omission reasons.
- [ ] Live context is not persisted by audit recording.
- [ ] Prompt, schema, policy, source, container, context, redaction, and builder version invalidation.
- [ ] Prompt injection treatment and deterministic flag consistency.
- [ ] Evidence allowlist, delta evidence, enum, bound, and schema rejection.
- [ ] Prepared-call expiry and stale submission.
- [ ] Cached output revalidation and invalid-cache eviction.
- [ ] Zero model work for unchanged inputs.

### 17.3 Findings and projections

- [ ] Idempotent extraction-to-finding projection and backfill.
- [ ] Immutable finding plus explicit status events.
- [ ] Supersession and dismissal effects on current state.
- [ ] Stable projection rebuild and provenance.
- [ ] No model call during deterministic rebuild.
- [ ] Bounded recursive compression.
- [ ] No automatic proposal or mutation.

### 17.4 Proposal and effects

- [ ] Eligible and ineligible finding kinds/owners.
- [ ] Deterministic plan text, target, ID, due date, and preview.
- [ ] Policy absent, denied, changed, and permitted-with-approval cases.
- [ ] Short-lived single-use token bound to exact action and hashes.
- [ ] Stale source and stale target rejection at authorization and apply.
- [ ] Atomic application, backup, audit, and stable provenance.
- [ ] Duplicate apply rejection.
- [ ] Undo success and changed-target rejection.
- [ ] Sanitized MCP, CLI, and UI output.

### 17.5 Required handoff checks

```bash
bun run typecheck
bun test
git diff --check
```

Python changes additionally require a focused `uv run` smoke test. Live provider checks are reported
separately and completion is not claimed when OAuth grants, MCP reloads, runtime dependencies, or live
verification remain outstanding.

## 18. Parallel-agent execution guide

Parallel work is useful only when shared ownership remains explicit.

### 18.1 Safe parallel units

- Provider-local adapter/normalizer tests with no shared schema changes.
- Provider-specific prepared-workflow definitions after the coordinator contract is fixed.
- Deterministic finding projectors after the finding schema is fixed.
- Projection builders for different state families after the projection contract is fixed.
- UI components against stable sanitized API contracts.

### 18.2 Single-owner units

- `src/db/schema.ts` and each schema-version increment.
- Shared reasoning coordinator and prompt contracts.
- Context manifest contract.
- Policy, authorization, executor registry, and write tools.
- `src/mcp/server.ts` tool names and allowlist.
- `src/cli.ts` command registration.
- Lockfiles and privacy harness policy.

### 18.3 Required implementation handoff

Every downstream agent reports:

1. Files and schema versions changed.
2. New or changed CLI commands, MCP tools, annotations, and permissions.
3. Data retained and explicitly not retained.
4. Complete cache/invalidation identity.
5. Tests and live checks run with exact results.
6. Known gaps, reset/backfill steps, breaking effects, and required reloads.

Agents must also state which reference contracts in this document they implemented, refined, or found
inapplicable. Deviations should be captured in an architecture decision record rather than silently
encoded in provider-local code.

## 19. Definition of done

An architecture phase or integration is complete only when:

- its deterministic selection, normalization, identity, and invalidation behavior are specified;
- retention and non-retention are explicit and tested;
- ingestion and extraction remain separate;
- all model-backed work uses a bounded context manifest and prepared reasoning lifecycle;
- model output is schema- and evidence-validated against current immutable inputs;
- derived state retains provenance and can be regenerated;
- no proposal or effect occurs unless its workflow explicitly reaches that stage;
- proposals are deterministic, reviewable, policy-authorized, and stale-safe;
- user-facing output is sanitized;
- unchanged replay performs zero duplicate work;
- automated checks pass;
- required live checks, schema resets, OAuth grants, and reloads are truthfully reported.

## 20. Architectural decisions and open questions

The following decisions are made by this specification:

1. Shared lifecycle semantics are unified before provider storage.
2. Provider-specific tables remain valid privacy boundaries.
3. Prepared reasoning is the primary model lifecycle; direct completion is only a possible transport.
4. Findings are the cross-provider semantic layer.
5. Projections are regenerable views, not canonical prose.
6. The internal work queue is narrow and introduced after workflow consolidation.
7. Effects are typed and code-registered; there is no generic mutation interface.
8. Read-only application registration may be generated; mutation registration remains explicit.

Open questions to resolve through ADRs and measured implementation experience:

- Should common findings become canonical immediately, or remain projections of provider extraction
  records until the domain model is proven?
- Which reasoning preparation facts require durable minimal storage, versus reconstruction from source
  identities?
- Does the existing `change_events` table evolve into a universal source delta log, or should providers
  project into a new normalized delta table?
- Is a durable work queue justified by backlog and recovery needs, or is a deterministic query-backed
  queue sufficient initially?
- Which task proposal types can safely share a finding-based planner without erasing provider-specific
  eligibility rules?
- What is the minimum useful audit UI that preserves privacy while making stale and failed work
  understandable?

These questions do not weaken the fixed invariants. When uncertain, prefer the narrower data and
permission surface and preserve explicit provider boundaries.

## 21. Initial contextual-development slice

The first implemented slice establishes the contract for contextualizing a new Messages development.
It is intentionally narrower than the complete target architecture:

- Schema version 17 includes `subject_links` for internal Messages-conversation-to-person links only.
- A link is created explicitly with `message link-person`; it is not inferred or exposed as an MCP
  mutation.
- The command accepts a source conversation only at the CLI boundary, verifies that it is inside the
  configured selection, and stores only its derived internal identity.
- The link is bound to the ingested participant-set hash. A participant-set change makes the link
  ineligible until explicitly reviewed again.
- Context preparation retrieves the linked current person projection and open current tasks whose
  `person_id` matches.
- Calendar context is included only when a current compact calendar event mentions an established
  display name or alias as a complete textual term. This is retrieval relevance, not a canonical entity
  association.
- Person, task, and calendar context items receive allowlisted state evidence descriptors. A new
  extraction item must still cite newly changed Messages evidence.
- Submission rejects if any included derived state is no longer current.
- The live manifest contains bounded useful state. The persistable audit manifest removes message text,
  person names and aliases, interaction summaries, task descriptions, and calendar summaries/locations.

Current limitations are deliberate:

- There is no automatic person association, entity merge, or model-created link.
- There is no MCP tool for association mutation.
- Only Messages extraction consumes subject links.
- Calendar matching is conservative lexical retrieval and does not create a durable event-person link.
- Common findings and the internal work queue remain future phases.

Downstream implementations should extend the subject-link enum and public workflows only through a
coordinated schema and policy review. They should not turn the initial table into a generic graph-write
surface.

## 22. Initial prepared-reasoning lifecycle

The second implemented slice extracts the common durable lifecycle used by subscription-host
prepare/submit workflows. `src/orchestration/prepared-reasoning.ts` now owns:

- creation of a `prepared` model-call record with exact workflow and task identity;
- persistence of a workflow-sanitized audit manifest under the live context hash;
- submit-time lookup requiring the exact workflow, task type, status, and manifest hash;
- completion with optional input, output, and cached-token usage.

Gmail extraction, Messages extraction, and subscription morning reasoning use this service. Their
provider selection, refetch, source/container identity, evidence validation, output validation, and
derived-result persistence remain workflow-owned. This is intentionally a lifecycle service rather
than a generic callback-driven workflow engine.

Morning reasoning now persists evidence identity without duplicating compact-state content in the
context manifest. Submission verifies that each prepared daily and chief-of-staff projection remains
current. A superseded projection makes the preparation stale and requires a fresh reasoning request.

The direct `ModelGateway` remains unchanged as a separate transport-oriented path. Unifying it with the
prepared subscription lifecycle requires a later ADR because cache execution and synchronous adapter
calls have different operational states.

## 23. Initial common findings projection

The third implemented slice adds immutable common findings while retaining Gmail and Messages
extraction tables as the canonical provider-specific records.

- Schema version 17 includes `findings` and append-only `finding_status_events` alongside subject links.
- A finding identity is derived deterministically from source type, extraction ID, and item index.
- Semantic content and evidence are content-hashed; replay with different content under the same source
  identity fails closed.
- Validated new Gmail and Messages extraction submissions project findings immediately.
- `state rebuild` scans existing model extraction records and performs an idempotent no-model backfill.
- Deterministic Messages service triage is not projected in this slice because it does not have the same
  reasoning-call and evidence contract.
- SQLite findings retain kind, statement, owner, due date, confidence, ambiguities, exact internal
  evidence provenance, source extraction identity, reasoning call, content hash, and initial status.
- Sanitized `findings review` returns useful finding content, evidence count, and current lifecycle state,
  but omits provider/source type, extraction ID, reasoning-call ID, evidence IDs, and hashes.
- Finding creation and backfill create no proposal or canonical/provider mutation.

Dismissal, supersession, conversion, and finding-based task proposals remain later work. Their schema
states exist so lifecycle changes can be append-only, but no generic status mutation surface is exposed
by this slice.

## 24. Initial finding attention projection

The fourth implemented slice derives a single current `finding_attention_state` from common findings.
The aggregate projection contains bounded active open-loop and commitment items, counts, and overdue
finding IDs. It deliberately excludes decisions and informational findings from the attention queue.

Projection invalidation includes:

- the projection builder version;
- the current date, because overdue classification is date-sensitive;
- each included finding ID and immutable content hash;
- each finding's latest status-event ID and timestamp.

An unchanged rebuild reuses the current derived state. A later status event or date boundary creates a
new version. Dismissed, superseded, and converted findings are absent from the active projection.

Chief-of-staff state now depends on finding attention state and carries active finding open-loop IDs,
active finding commitment IDs, and overdue finding IDs alongside canonical task IDs. Morning briefing
resolves overdue finding IDs back to their structured statements and cites both the finding ID and
attention-state ID. No provider extraction identifiers or evidence hashes are copied into the
projection content.

The status-event writer remains an internal narrow repository method used to prove lifecycle
invalidation. No CLI, MCP, or model-facing generic finding-status mutation is introduced here.

## 25. Reviewed finding lifecycle and task conversion

The fifth implemented slice adds narrow reviewed lifecycle operations and generalizes fixed-inbox task
proposals from provider-specific extraction items to common findings.

Finding lifecycle behavior:

- CLI `findings dismiss` appends a `dismissed` event and requires a non-empty reason.
- CLI `findings supersede` appends a `superseded` event, requires a distinct existing replacement
  finding, and records a non-empty reason.
- Only active findings may transition through these operations; repeated terminal transitions fail.
- Both commands immediately rebuild finding attention and chief-of-staff state.
- No generic lifecycle MCP mutation is exposed.

Finding task behavior:

- `life_os_propose_finding_task` accepts only one `finding_*` ID.
- The finding must be active, user-owned, and one of `explicit_request`, `open_loop`, or
  `user_commitment`.
- Life OS derives the fixed inbox path, exact task line, due date, stable task ID, finding-content hash,
  target hash, and review preview. The caller supplies none of them.
- The proposal workflow identity includes the finding ID, allowing distinct findings to have distinct
  pending proposals against the same unchanged inbox while retaining idempotent replay per finding.
- Authorization preparation and consumption both reject a non-active or content-mismatched finding.
- Application repeats the finding, plan, policy, path, and target checks before an atomic file write.
- The `converted` finding event is committed in the same SQLite transaction as applied proposal/action
  state and undo metadata, and is related to the stable task ID.
- Undo restores the file and appends a new `active` finding event related to that task.

The earlier email-extraction-specific proposal and executor surfaces were removed during prototyping.
All task proposals now originate from common findings.

## 26. Registered projection contract and reconciliation

The sixth implemented slice replaces ad hoc projection invalidation with one typed contract. Schema
version 16 introduced explicit builder name, builder version, normalized input provenance, and dependency
hash columns to every derived-state record; schema version 17 retains them. Non-projection derived states receive conservative legacy
metadata at the storage boundary, while registered deterministic builders provide complete identities.

The coordinated registry contains project, person, task, finding-attention, and chief-of-staff builders.
Each builder declares its output state type and derives its dependency hash from its name, version, and
sorted typed input identities. Replaying an identical build returns the existing state row without
storage churn. A builder-version change invalidates its output even when source content is unchanged.

Full state rebuild now scans and validates all canonical state candidates before reconciling current
projections. Project, person, and task projections whose canonical inputs disappeared are explicitly
retired by setting their current row's `superseded_at`; history remains available for audit. Targeted
rebuild accepts only typed state/entity targets, projects matching live inputs, and retires an explicitly
targeted entity when its source no longer exists. Downstream attention and chief-of-staff builders run
through their dependency checks, so targeted and full rebuilds converge without duplicate versions.

Date is a declared input to time-sensitive projections. Clock movement within a date produces no new
state, while a date boundary invalidates overdue classifications. The deterministic morning briefing is
also materialized through the projection contract. Subscription-agent recommendations remain in the
separate `briefing_reasoning_state` overlay and are never copied into deterministic daily state.

Reconciliation reads Markdown but does not write it. Tests cover stable replay, complete provenance,
source and task removal, full/targeted convergence, finding lifecycle invalidation, date rollover, the
separate recommendation overlay, and byte-for-byte preservation of human-authored journal prose.

## 27. Internal extraction work queue

The seventh implemented slice replaces Gmail and Messages “next unprocessed” queries with one durable
metadata-only work queue. Schema version 17 adds `work_items` with explicit pending, leased, completed,
stale, and failed states; bounded attempts; lease expiration; availability time; priority; and a small
sanitized error-category enum.

The invalidation key hashes workflow, subject type, internal provider/source identity, anchor identity,
source hash, container hash, reason, and—only for explicit contract refreshes—prompt/schema/policy
identity. Provider identifiers and immutable hashes remain internal SQLite metadata. Work rows contain
no message body, source excerpt, prompt blob, arbitrary JSON payload, command, path, patch, URL, or SQL.

Gmail emits work in the same transaction that stores a changed message, immutable version, and thread
state. Messages emits one item per changed conversation in the same transaction that stores the batch,
refreshes conversation state, and advances the bounded cursor. A failure to enqueue therefore rolls
back the matching provider commit and cursor advancement. Unchanged replay inserts no work.

Only one worker can atomically claim an available item. Claims use `BEGIN IMMEDIATE`, a named owner,
bounded expiration, and an incremented attempt count. Expired leases return to pending until the attempt
limit, then fail as `retry_exhausted`. A new source or container identity stales older pending or leased
work for the same subject before inserting the replacement. Explicit retry categories never store raw
provider errors.

Both subscription extraction prepares claim work before exact refetch. The work ID, lease identity,
source hash, and container hash are bound into the prepared context manifest. Submission rechecks the
lease and current provider/container identities. Provider extraction, common findings, prepared model
call completion, and work completion commit in one SQLite transaction. A competing prepare cannot
create a second model call while the first lease is active.

Deterministic Messages service triage reads the same ready queue, claims only messages matched by a
deterministic rule, and commits triage plus work completion atomically. Unmatched work remains available
for model extraction. Calendar remains outside this first queue slice because it is deterministic and
has different retry semantics.

`life_os_work_status` and `life-os work status` expose only aggregate state/workflow counts and oldest
pending age. They return no work IDs, provider IDs, subjects, addresses, excerpts, source hashes, or raw
errors. Tests cover idempotent enqueue, exclusive claims, changed-source replacement, lease recovery,
bounded retry, provider replay, transactional extraction/finding completion, cursor safety, and work-row
non-retention.

## Appendix A: Example end-to-end flows

### A.1 Incoming message to reviewed finding

```text
configured conversation receives a new turn
  → readonly adapter selects the row
  → normalizer computes message and conversation hashes
  → provider store commits metadata/version/cursor
  → delta creates one extraction work identity
  → prepare exact-refetches bounded recent turns
  → current hashes are verified
  → high-risk PII policy runs locally
  → context builder selects delta + limited prior context
  → audit sanitizer removes text and participant data
  → host receives prompt, schema, live context, evidence allowlist
  → host returns structured candidate findings
  → submit rechecks conversation and exact selected source
  → schema and delta-evidence validation succeeds
  → provider extraction and common findings are committed
  → sanitized review shows an open loop without provider IDs or excerpts
```

No task, reply, send, proposal, or provider mutation occurs.

### A.2 Finding to Obsidian task

```text
user selects eligible active finding
  → code checks kind and owner
  → task text/due date/stable ID are derived
  → target is fixed to canonical inbox
  → source and target hashes are captured
  → policy permits create_task with approval
  → pending proposal exposes exact sanitized preview
  → user explicitly approves exact action
  → short-lived token binds proposal/action/target hash
  → apply rechecks policy, finding state, target path, and target hash
  → external backup is created
  → sibling temp file is atomically renamed
  → action result and undo record are committed
  → projections rebuild from canonical Markdown
```

### A.3 Morning briefing

```text
vault and provider deltas are ingested
  → deterministic task/project/person/calendar/open-loop projections rebuild
  → briefing formatter selects current bounded facts
  → optional reasoning prepare uses compact projections and evidence descriptors
  → host returns at most the schema limit of recommendations
  → submit validates current projection/context identity and evidence
  → recommendations are displayed as an overlay
```

Recommendations do not alter canonical state or silently reprioritize tasks.

## Appendix B: Review checklist for architectural changes

- [ ] Does the change preserve the canonical Markdown versus operational SQLite boundary?
- [ ] Is provider access narrower than the requested capability, or exactly as narrow?
- [ ] Can unchanged input avoid storage churn and model work?
- [ ] Are source, container, context, prompt, schema, policy, and builder identities complete?
- [ ] Is transient source content absent from durable manifests, logs, errors, and reviews?
- [ ] Is every model output treated as untrusted and validated after generation?
- [ ] Can evidence be forged, reused after change, or displayed unsafely?
- [ ] Is derived state reproducible from canonical inputs?
- [ ] Can a caller select a path, patch, command, URL, SQL statement, or executor?
- [ ] Is mutation separated from reasoning by proposal, review, authorization, and revalidation?
- [ ] Is authorization exact, short-lived, single-use, and stale-safe?
- [ ] Can a failure advance a cursor, duplicate a finding, or replay an effect?
- [ ] Are MCP, CLI, UI, logs, metrics, and audit projections sanitized consistently?
- [ ] Does the test plan cover schema reset behavior, replay, concurrency, stale state, and privacy?
- [ ] Is ownership of shared files and schema version explicit?
