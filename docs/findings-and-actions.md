# Findings and Actions

## Purpose

Life OS should seek value by noticing consequential changes, relating them to the user's existing
commitments and priorities, and offering the smallest useful next step. It should not equate value
with producing more summaries, tasks, notifications, or model output.

This design builds on the target architecture in `../life-os-architecture/docs/architecture.md`,
reviewed on `feature/architecture` at commit `a717e1d`. That architecture gives **Finding** a precise
meaning: an immutable, validated, cross-provider semantic record such as an explicit request,
commitment, decision, or date. This document does not redefine that contract.

The additional value-seeking unit proposed here is an **attention signal**: a current, explainable
assessment of why one or more findings and projections may deserve the user's attention. An attention
signal is distinct from both an immutable finding and an action:

```text
provider or vault change
  -> immutable evidence
  -> provider extraction
  -> immutable common Finding
  -> deterministic projections
  -> current AttentionSignal
  -> ranked presentation or SuggestedIntervention
  -> reviewed proposal
  -> policy-authorized mutation
  -> outcome and feedback
```

This separation preserves the architecture branch's ingestion, finding, projection, proposal,
approval, and privacy boundaries while making the system's value-seeking behavior explicit and
testable.

## Relationship to the architecture branch

The architecture branch already implements or specifies the lower-level foundation this work needs:

- common immutable `findings` projected from Gmail and Messages extraction records;
- append-only finding lifecycle events for dismissal, supersession, conversion, and reactivation;
- a current `finding_attention_state` containing active open-loop and commitment findings;
- chief-of-staff and morning-briefing consumption of that attention state;
- reviewed finding-to-task conversion through the existing fixed-inbox proposal boundary;
- registered deterministic projection builders with explicit input provenance and builder versions;
- reconciliation when canonical project, person, or task inputs disappear.

This branch should therefore not independently own schema versioning, common finding persistence,
projection infrastructure, task proposal generalization, MCP registration, or CLI lifecycle commands.
Those changes should arrive by synchronizing with `feature/architecture` after its work is merged or
otherwise designated as the shared base.

The remaining product question is one layer higher: given immutable findings plus current task,
project, person, schedule, and attention projections, how should Life OS determine what matters, what
has already been handled, and which intervention has enough expected value to justify the user's
attention?

| Concept | Example | Owner and behavior |
| --- | --- | --- |
| Common `Finding` | “The user committed to send the proposal Friday.” | Architecture finding layer; immutable, source-grounded, evidence-bearing |
| Finding status event | “This finding was converted to task `task_*`.” | Architecture lifecycle layer; append-only disposition without rewriting the finding |
| Projection | Current tasks, calendar, people, projects, and active commitments | Architecture state layer; deterministic, regenerable, versioned by typed inputs |
| `AttentionSignal` | “The Friday commitment is untracked and now at risk.” | This design's interpretation layer; current assessment derived from findings and projections |
| `SuggestedIntervention` | “Create a task,” “ask for clarification,” or “draft a follow-up” | This design's value-selection layer; inert advice with no executor authority |
| Typed `EffectPlan` | Exact fixed-inbox append with source/target hashes | Architecture proposal layer; deterministic, reviewable, policy-bound |
| Applied action | The approved task append and its audit/undo records | Architecture effect layer; narrow executor after exact authorization |

Extraction prompts should produce common findings, not importance scores, notifications, or effect
plans. Attention builders should decide what currently matters, but must not invent source facts.
Intervention planning should choose among code-owned possibilities, but must not authorize an effect.

## Current baseline and remaining gap

The `feature/findings` branch currently starts from `main`, which predates the common-finding work. The
architecture branch should be treated as the incoming baseline for planning purposes.

| Layer | Current behavior | Limitation |
| --- | --- | --- |
| Provider selection | Gmail ingests `IMPORTANT`; Messages uses configured selection; Telegram uses an allowlist; Calendar reads the primary calendar | Selection is provider-specific and does not express user relevance consistently |
| Extraction and findings | Gmail and Messages output evidence-grounded items that project into immutable common findings | The existing kind vocabulary is intentionally narrow and does not encode higher-order attention judgments |
| Finding lifecycle | Status events support active, dismissed, superseded, converted, and reactivated behavior | Automatic resolution and cross-source semantic matching remain deliberately unimplemented |
| Deterministic triage | Messages suppresses verification codes and routine notices and recognizes pickup alerts | Deterministic triage does not yet project into common findings because its evidence contract differs |
| Attention projection | Active open loops, commitments, and overdue finding IDs flow into chief-of-staff and morning briefing | Decisions, reply need, conflicts, blockers, relationship signals, and cross-source risks are not represented |
| Projection framework | Registered deterministic builders own input provenance, reconciliation, and version invalidation | Richer attention semantics still need an explicit builder contract and fixtures |
| Actions | Any eligible active user-owned common finding can become a fixed-inbox task proposal | “Make a task” remains the only finding-driven intervention; drafts, state corrections, and other narrow proposals are absent |
| Feedback | Briefing items can be marked useful; proposals and finding lifecycle record disposition | Feedback is not tied to attention-signal type, presentation channel, suppression, or eventual outcome |

The immediate design problem is therefore not “which new prompt should inspect messages?” It is:

1. Does the existing finding vocabulary capture the source-grounded semantics needed downstream?
2. Which combinations of findings and projections constitute an attention signal for this user?
3. Which signals deserve silence, a digest, a question, a recommendation, or a proposal?
4. Which later findings or canonical state changes resolve or supersede each signal?
5. Did the intervention help enough to justify its cost and interruption?

## Implemented first slice

`feature/findings` now includes the architecture foundation through commit `a717e1d` and a first
deterministic attention resolver layered on its registered projections.

The resolver currently derives:

- `untracked_user_commitment` when an active user commitment has no exact normalized open-task match;
- `waiting_on_other` when an active other-owned commitment has no recorded resolution;
- `commitment_at_risk` when an active commitment's explicit due date has passed;
- `deadline_not_tracked` when an exactly matching open task lacks the finding's explicit date;
- `duplicate_commitment` when identical normalized active findings or open tasks repeat an obligation.

Matching is deliberately conservative: Unicode-normalized, case-insensitive, punctuation-insensitive,
and otherwise exact. It does not use semantic similarity. Findings below `0.75` confidence are counted
but suppressed from attention. A task-creation intervention backed by an ambiguous finding is marked
`needs_clarification`, not ready. Current task projection identities and the calendar date are part of
the attention projection's invalidation identity. When a matching canonical task appears, the
untracked signal disappears on rebuild without rewriting the immutable finding.

Signals are ranked deterministically by urgency, impact, type, and stable attention ID. They flow into
chief-of-staff state and a distinct morning-briefing Attention section. Suggested interventions are
inert structured options; only the already-supported finding task proposal is marked ready. Draft
follow-up and task-date update interventions are explicitly `unsupported` until narrow workflows and
effect plans exist.

The pure resolver also supports compatibility inputs for the next architecture revision:

- a validated communication context supplies direction, response expectation, response state,
  validator version, and content hash;
- a validated finding relation connects two distinct active findings through `responds_to`, `resolves`,
  or `supersedes`, with confidence, validator version, and content hash;
- an incoming, required, awaiting-response context derives `response_needed` or `response_overdue`;
- a validated response relation suppresses reply attention;
- a validated resolution relation replaces commitment risk with `commitment_resolved` and offers
  review plus an explicitly unsupported task-completion intervention when a matching task exists;
- stale finding references, duplicate identities, self-relations, and incomplete validator identities
  fail closed.

The current `finding_attention_state` builder does **not** supply these compatibility inputs because the
common finding store does not yet persist their final architecture-owned representation. Production
therefore continues to avoid response and automatic-resolution claims. Once the architecture branch
defines that representation, its content hashes and validator versions must become explicit projection
inputs before these signals are enabled.

### Implemented presentation policy

The deterministic presentation router uses four channels: `suppress`, `review_queue`,
`morning_briefing`, and `immediate_notification`. Every decision includes a reason, explanation, and
`attention-presentation-v1` policy identity.

- Signals below `0.75` confidence are suppressed.
- High-impact or today-urgent signals enter the morning briefing.
- Medium-impact signals and signals with a reviewable intervention enter the review queue.
- Low-impact, non-urgent signals with no reviewable intervention are suppressed.
- Immediate notification is disabled by default. Even when explicitly enabled, it requires a
  high-impact, today-urgent signal plus a distinct validated safety-risk or irreversible-loss context
  with at least `0.9` confidence and an effective time no more than four hours away.

The attention projection records presentation decisions and includes the policy version in its
invalidation identity. Chief-of-staff state carries the decision with each signal. The deterministic
morning briefing includes only `morning_briefing` signals; review-queue and suppressed signals are not
silently promoted into the daily briefing. No production path currently supplies or enables immediate
interruption contexts.

The redacted table-driven evaluation corpus covers tracked, untracked, overdue, ambiguous, duplicate,
response-needed, response-overdue, responded, resolved, low-confidence, and explicitly validated
immediate-interruption cases. It is the initial behavioral specification for future architecture and UI
integration.

### Implemented projection freshness

Successful Gmail and Messages extraction commits now trigger a deterministic refresh of
`finding_attention_state` followed by `chief_of_staff_state`. The refresh happens after the atomic
extraction/finding/model/work transaction, so a projection error cannot roll back or misclassify
completed provider work. The submit response contains only a sanitized receipt:

- `completed` with attention and chief-of-staff state versions; or
- `failed` with the fixed `projection_refresh_failed` category.

Raw errors are never returned. Refresh makes no model calls, proposals, actions, provider mutations, or
vault writes. Repeating it over unchanged dependencies creates no state churn. If refresh fails, an
ordinary deterministic state rebuild recovers from the already-validated findings.

### Implemented sanitized attention review

The domain-local attention review compiler reads one current `finding_attention_state` and returns at
most 50 priority-ordered `review_queue` items. It reports aggregate counts for every presentation
channel, but does not expose morning, immediate, or suppressed signal details in the review list.

The compiler requires exactly one current `attention-presentation-v1` decision for every signal and
rejects missing, duplicate, unknown, malformed, or stale identities. It selects and bounds each useful
field rather than copying projection objects. Review items may include stable finding IDs needed for
the existing finding-task proposal, but omit state IDs, task IDs, provider/source identities, hashes,
headers, addresses, excerpts, and unrecognized fields. Counts report returned and omitted items when
the queue exceeds its bound.

The accompanying feedback contract supports only `useful`, `incorrect`, `duplicate`,
`already_handled`, `irrelevant`, `too_late`, and `too_intrusive`. Feedback is bound to the exact visible
attention ID, channel, reason, and presentation policy version. The caller supplies only attention ID,
disposition, and timestamp; free-form prose and feedback on suppressed signals are rejected. This slice
defines and validates records only—no feedback persistence or public CLI/MCP/UI surface exists yet.

## Evolution of the common finding vocabulary

Extraction should remain provider-local and factual. The architecture branch's existing common
finding kinds are the compatibility baseline. The vocabulary below is a proposed evolution to evaluate
against real fixtures, not a second assertion table or an immediate enum replacement. It describes
what happened in a source without deciding how important it is.

### Candidate common finding semantics

| Candidate semantic | Meaning |
| --- | --- |
| `request_made` | Someone explicitly asked an actor to do or provide something |
| `question_asked` | A question was directed to an actor and may require an answer |
| `commitment_made` | The user, another person, or a group explicitly committed to an outcome |
| `commitment_completed` | A previously identified commitment was explicitly fulfilled |
| `commitment_declined` | A request or commitment was explicitly refused or withdrawn |
| `decision_requested` | A choice or approval is needed from an actor |
| `decision_made` | A choice was explicitly made |
| `delegation_made` | Ownership moved from one actor to another |
| `status_reported` | Progress, completion, delay, or lack of progress was reported |
| `blocker_reported` | A dependency or obstacle was explicitly identified |
| `date_proposed` | A possible date or time was introduced but not agreed |
| `date_confirmed` | A date, deadline, appointment, or reservation was confirmed |
| `date_changed` | An earlier date or time was rescheduled |
| `event_canceled` | A planned event or obligation was canceled |
| `availability_shared` | An actor stated availability or unavailability |
| `invitation_received` | The user was invited to an event, conversation, or opportunity |
| `relationship_update` | A durable personal or organizational fact changed |
| `project_update` | Scope, outcome, milestone, risk, or project state changed |
| `reference_shared` | Information or an artifact was supplied primarily for later reference |
| `supersession` | New content explicitly replaces older content |
| `correction` | A prior fact was corrected |
| `acknowledgment` | Receipt was acknowledged without adding a new obligation |

Ownership, direction, temporal status, and certainty should be fields, not additional kinds. For
example, a request can target `user`, `other`, `shared`, or `unknown`; a date can be `proposed` or
`confirmed`; and a commitment can be `open`, `completed`, `declined`, or `superseded`.

### Safety and routing results

These results do not become ordinary attention items:

| Routing result | Default treatment |
| --- | --- |
| `untrusted_instruction_detected` | Preserve an indicator, ignore the instruction, and expose a sanitized warning only when useful |
| `sensitive_ephemeral_message` | Do not retain the secret or code; normally suppress |
| `routine_notification` | Suppress or count in a low-priority digest |
| `content_unavailable` | Record an operational gap without pretending extraction succeeded |
| `identity_ambiguous` | Avoid entity attachment and request clarification only if consequence warrants it |

## Attention-signal taxonomy

Common findings become attention signals only after they are compared with current tasks, projects,
people, calendar state, earlier findings, lifecycle events, and user preferences. The attention-signal
type explains **why the item may deserve the user's attention**. These are derived projection semantics,
not replacements for immutable common finding kinds.

### 1. Communication attention

| Signal type | Trigger | Useful next steps |
| --- | --- | --- |
| `response_needed` | A current incoming request or question is directed to the user and has no later response or resolution | Show in reply queue; offer a reply outline or task proposal |
| `response_overdue` | A high-confidence response need has exceeded an explicit or user-configured expectation | Elevate in briefing; offer follow-up action |
| `clarification_needed` | Ambiguity blocks a consequential commitment, decision, date, owner, or action | Ask one focused question or draft a clarification message |
| `acknowledgment_sufficient` | The likely useful response is only confirmation of receipt | Offer a short acknowledgment; avoid creating a task by default |
| `no_response_needed` | The message is informational, resolved, or routine | Suppress while retaining only permitted structured state |

### 2. Commitments and open loops

| Signal type | Trigger | Useful next steps |
| --- | --- | --- |
| `untracked_user_commitment` | The user made or accepted a commitment that is absent from canonical tasks | Propose a task with grounded wording and date |
| `waiting_on_other` | Another actor owns an unresolved commitment relevant to the user | Propose or update a waiting item and follow-up date |
| `commitment_at_risk` | A commitment is near or past its date, blocked, or contradicted by current state | Surface consequence and propose recovery or renegotiation |
| `commitment_resolved` | Later evidence shows completion, refusal, cancellation, or supersession | Propose completion/cancellation of linked state; remove from active queues |
| `orphan_open_loop` | An actionable exchange has no clear owner or next step | Ask for owner/intent or suggest a concrete next action |
| `duplicate_commitment` | The same obligation appears in multiple sources or already exists as a task | Link evidence; suppress duplicate creation |

### 3. Decisions

| Signal type | Trigger | Useful next steps |
| --- | --- | --- |
| `decision_needed` | A choice or approval is explicitly requested or required to unblock work | Produce a compact decision brief or ask for the choice |
| `decision_deadline` | A decision has an explicit deadline or an expiring consequence | Elevate according to consequence and time remaining |
| `decision_missing_context` | A material choice lacks required options, owner, constraint, or evidence | Identify the missing information; do not fabricate a recommendation |
| `decision_recorded` | A decision was made but is absent from canonical project or decision state | Propose recording it and resolving superseded options |
| `decision_reopened` | New evidence contradicts or invalidates a prior decision | Explain the change and request review rather than silently overwriting history |

### 4. Time and schedule

| Signal type | Trigger | Useful next steps |
| --- | --- | --- |
| `event_not_on_calendar` | A confirmed user-relevant appointment or event is absent from Calendar | Propose a calendar entry or a vault task; never create it silently |
| `schedule_change_unapplied` | A confirmed reschedule or cancellation conflicts with current Calendar or task state | Propose the exact update and identify what changed |
| `calendar_conflict` | Confirmed events overlap or violate a user-configured buffer | Surface the conflict and possible resolution |
| `deadline_not_tracked` | An explicit deadline is absent from the linked task or project | Propose adding the date to canonical state |
| `upcoming_time_risk` | Travel, preparation, prerequisite, or lead time is missing for a near-term event | Suggest preparation only when supported by evidence or policy |
| `stale_plan` | A proposed or expected date passed without confirmation or resolution | Ask whether to reschedule, abandon, or follow up |

### 5. Projects and execution

| Signal type | Trigger | Useful next steps |
| --- | --- | --- |
| `project_progress_unrecorded` | Traffic contains a material milestone or completion not reflected in project state | Propose a bounded project update |
| `project_blocked` | A blocker or missing dependency prevents the next action | Surface owner, consequence, and unblock option |
| `project_scope_changed` | Requirements, deliverables, or ownership materially changed | Show a before/after summary and propose state updates |
| `project_has_no_next_action` | An active project lacks an executable next action | Recommend defining one; do not invent it if intent is unclear |
| `priority_conflict` | A new commitment conflicts with stated priorities, capacity, or deadlines | Ask for reprioritization with explicit tradeoffs |
| `handoff_needed` | Work is ready for another actor or stalled awaiting a handoff | Propose the handoff or a waiting item |

### 6. Relationships

| Signal type | Trigger | Useful next steps |
| --- | --- | --- |
| `follow_up_due` | A promised follow-up or configured contact cadence is due | Suggest contact with grounded context |
| `relationship_context_unrecorded` | A durable, useful personal fact or interaction belongs in a person record | Propose a narrow append or metadata update |
| `relationship_open_loop` | A person-specific promise, request, introduction, or favor remains unresolved | Link it to the person and propose the smallest next step |
| `introduction_pending` | An offered or requested introduction has not been completed | Propose the introduction task or clarification |
| `sensitive_relationship_signal` | A potentially delicate inference lacks explicit support | Do not persist or surface it as fact; require strong evidence and user benefit |

### 7. Opportunities, references, and administrative items

| Signal type | Trigger | Useful next steps |
| --- | --- | --- |
| `opportunity_requires_choice` | An invitation or opportunity is time-bound and plausibly relevant | Present accept/decline/ignore options without manufacturing urgency |
| `reference_worth_filing` | Supplied information is likely to be needed for an active entity | Propose linking or filing a sanitized reference, subject to retention policy |
| `administrative_action` | Renewal, pickup, form, payment, document, or account action is explicitly required | Propose a task; retain no forbidden secrets or source bodies |
| `delivery_or_reservation_change` | A delivery, booking, or reservation changed in a way that affects a plan | Surface or propose an update according to consequence |
| `low_value_notification` | Content is routine, promotional, duplicate, or already reflected elsewhere | Suppress and count for transparency |

### 8. System integrity and knowledge quality

| Signal type | Trigger | Useful next steps |
| --- | --- | --- |
| `state_source_mismatch` | Canonical state contradicts newer, well-supported evidence | Request review and propose an exact correction |
| `entity_identity_ambiguous` | Evidence could attach to more than one person, project, or task | Ask for disambiguation; never silently merge entities |
| `missing_provenance` | A derived item cannot be traced to allowed evidence | Reject it rather than presenting it as a finding |
| `stale_attention` | A contributing finding, projection, date, builder, prompt, or policy identity changed | Invalidate and recompute before action |
| `integration_gap` | Provider content could not be read, normalized, or checked | Report the bounded operational gap without claiming there is no work |
| `unsafe_content_detected` | Deterministic indicators identify prompt injection or prohibited content | Treat as untrusted data and prevent it from influencing tools or policy |

## Attention-signal contract

The architecture's immutable common `Finding` remains the evidence-bearing semantic record. A derived
attention item should be emitted through a registered projection builder with enough structure to
rank, explain, invalidate, and act on it without retaining forbidden provider text.

```ts
interface AttentionSignal {
  attentionId: string;
  type: AttentionSignalType;
  state: "current" | "resolved";
  title: string;
  summary: string;
  subjectRefs: Array<{ type: "task" | "project" | "person" | "event" | "conversation";
    id: string }>;
  inputRefs: Array<{
    type: "finding" | "projection";
    id: string;
    version: string;
  }>;
  owner: "user" | "other" | "shared" | "unknown";
  confidence: number;
  impact: "low" | "medium" | "high" | "critical";
  urgency: "none" | "soon" | "today" | "immediate";
  dueAt: string | null;
  firstObservedAt: string;
  lastConfirmedAt: string;
  explanation: string;
  ambiguities: string[];
  builder: { name: string; version: string; method: "deterministic" | "validated_reasoning" };
}
```

The projection input chain leads back to common findings and their validated evidence. Sanitized
user-facing projections must continue to omit provider IDs, raw hashes, addresses, headers, source
excerpts, and other forbidden identifiers. `summary` and `explanation` are bounded derived output, not
retained source text.

### Identity and lifecycle

An attention identity should be stable for the same semantic condition, not regenerated for every new
message or rebuild. Its projection invalidation identity must include:

- attention-signal type and builder version;
- normalized subject/entity references;
- contributing immutable finding IDs and content hashes;
- relevant projection IDs, versions, and dependency hashes;
- the current date or configured thresholds when time-sensitive;
- prompt, model, context, and policy versions only when validated reasoning contributes.

Later findings or canonical state may confirm or remove an attention condition. A later “done,”
refusal, cancellation, reschedule, user action, finding status event, or linked task completion should
cause the projection to resolve the signal rather than repeatedly presenting it. The underlying common
findings remain immutable and provenance-preserving.

## Suggested-intervention contract

An attention signal can have zero or more suggested interventions. The signal states why something
deserves attention; the intervention states what the system or user could do about it. An intervention
is not an architecture `EffectPlan` and carries no authority. Only deterministic code may convert an
eligible intervention into a typed, reviewable effect plan.

```ts
interface SuggestedIntervention {
  kind: InterventionKind;
  attentionId: string;
  findingIds: string[];
  rationale: string;
  expectedBenefit: string;
  consequenceOfDelay: string | null;
  targetRef: { type: string; id: string } | null;
  permissionClass: "read" | "prepare" | "yellow" | "red";
  readiness: "ready" | "needs_clarification" | "unsupported";
  reversible: boolean;
  inputDependencyHash: string;
  expiresAt: string | null;
}
```

### Action ladder

The agent should choose the lowest-cost action that captures the available value.

| Level | Action | Examples | Boundary |
| --- | --- | --- | --- |
| 0 | Suppress | Ignore OTP, routine enrollment, duplicate notice, already-resolved loop | May retain only policy-permitted structured metadata |
| 1 | Organize | Classify, link through an approved narrow relationship, group into a review queue, rebuild attention state | Deterministic or validated derived state; no vault/provider mutation |
| 2 | Surface | Show in digest, morning briefing, needs-reply queue, conflict view | Sanitized projection with explanation and provenance |
| 3 | Clarify | Ask the user for owner, intent, date, identity, or desired disposition | Ask only when ambiguity blocks a consequential next step |
| 4 | Recommend or draft | Decision brief, reply draft, follow-up wording, task wording, project update preview | Draft is inert and bound to immutable evidence/context |
| 5 | Prepare proposal | Create/update/complete task; mark waiting; update project/person/decision state; prepare calendar change | Narrow target, exact preview, source/target hashes, expiry, explicit review |
| 6 | Apply approved proposal | Atomic allowlisted vault mutation with backup, audit, stale checks, and undo | Existing policy and authorization boundary remains mandatory |
| 7 | Provider mutation | Send/reply, modify Calendar, label/archive email | Not available in version 1; requires explicit future scope and narrow provider permissions |

The current hard prohibitions remain hard prohibitions. In particular, attention support must not add
arbitrary filesystem writes, paths, patches, SQL, commands, provider sends, journal rewrites, or silent
entity merges.

### Candidate intervention kinds

The future typed effect-plan work should distinguish interventions even when several eventually use
the same underlying vault tool. These are candidate intervention kinds, not registrations or new
permissions:

- `create_task`
- `update_task_date`
- `mark_task_waiting`
- `complete_task`
- `cancel_task`
- `record_decision`
- `append_project_update`
- `set_project_next_action`
- `append_person_interaction`
- `set_next_contact`
- `prepare_calendar_create`
- `prepare_calendar_update`
- `prepare_calendar_cancel`
- `draft_reply`
- `draft_clarification`
- `draft_follow_up`
- `link_reference`
- `dismiss_finding`
- `snooze_attention`

Only intervention kinds backed by a narrow typed effect plan, policy, proposal builder, validator,
allowlisted target, and tests may advance beyond a draft. Calendar and provider communication actions
are design placeholders until their permissions and review workflows are explicitly implemented.

## How the agent should choose what to show

The agent should not rank solely by confidence, recency, or the presence of an explicit request.
Selection should use separate, explainable dimensions:

- **Grounding:** Is every claim supported by current allowlisted evidence?
- **Relevance:** Does it affect a known priority, commitment, person, project, or configured interest?
- **Impact:** What is the likely consequence if the user does nothing?
- **Urgency:** When does that consequence become harder or impossible to avoid?
- **Novelty:** Is this genuinely new, changed, or unresolved?
- **Actionability:** Is there a specific next step the user can take?
- **Effort:** What attention or work would the intervention cost?
- **Reversibility:** Can a mistaken action be cheaply undone?
- **Preference fit:** Has the user found this type, source, or intervention useful before?

Confidence gates whether a claim may be made; it does not manufacture importance. Urgency requires an
explicit date, a deterministic time rule, or a policy-backed inference. A vague “ASAP” should not be
converted into a fabricated deadline.

### Presentation thresholds

| Channel | Appropriate threshold |
| --- | --- |
| Silent suppression | Low consequence, duplicate, routine, resolved, or irrelevant |
| Review queue | Useful but not time-sensitive; user can batch decisions |
| Morning briefing | Current, consequential, and actionable within the planning horizon |
| Immediate notification | High-confidence imminent harm or loss that cannot reasonably wait for the next review |

Immediate interruption should be rare, deterministic where possible, and separately configurable.
The default should be a review queue or briefing, not a notification.

## Cross-source examples

### Incoming request already tracked

1. A message contains a source-grounded request due Friday.
2. Entity resolution links it to an existing open task with the same obligation and date.
3. The attention resolver emits `duplicate_commitment`, not `untracked_user_commitment`.
4. The system links the new evidence and suppresses a duplicate task proposal.

The value is avoiding duplicate work, not creating another task.

### Commitment followed by cancellation

1. The user says they will attend, producing an immutable commitment finding.
2. Life OS derives `event_not_on_calendar` and offers a reviewed event proposal.
3. A later message cancels the event before approval.
4. The commitment finding is superseded, the attention signal resolves, and the stale proposal cannot
   be authorized.

The value is maintaining current state and rejecting stale action.

### Request blocked by missing information

1. An email requests a deliverable but omits the required format and deadline.
2. The system derives `clarification_needed`, with the missing fields in `ambiguities`.
3. It offers `draft_clarification`, not a guessed task date or finished reply.

The value is exposing the decision boundary without inventing facts.

### Calendar conflict introduced by traffic

1. A conversation confirms an appointment.
2. Calendar state contains an overlapping event.
3. The system derives `calendar_conflict` with both sanitized event references.
4. It offers options to clarify, decline, or prepare a reschedule; it does not modify Calendar.

The value comes from correlating sources, not from summarizing either source independently.

### Other person's promise becomes stale

1. Another person promises to send a document by Tuesday.
2. The resolver derives `waiting_on_other` and optionally proposes a waiting task.
3. Tuesday passes without later evidence or task resolution.
4. The attention signal becomes `response_overdue` or `commitment_at_risk` and offers a follow-up
   draft.

The value is lifecycle tracking, not repeatedly extracting the same promise.

## Proposed implementation sequence

This sequence starts after synchronizing with the architecture branch. It deliberately does not repeat
the implemented common-finding store, lifecycle events, finding-attention projection, finding-to-task
conversion, or registered projection contract.

### Phase A: Semantic contracts and evaluation corpus

- Characterize the architecture branch's current common finding kinds and attention behavior.
- Build redacted fixtures covering requests, questions, commitments, waiting, decisions, corrections,
  reschedules, cancellations, ambiguity, prompt injection, duplicates, and resolution.
- Define the expected common findings, attention signals, suppressions, presentation channels, and
  allowed interventions for each fixture.
- Decide which missing semantics require a common-finding vocabulary change and which belong only in
  a deterministic attention projection.
- Establish baseline precision, duplicate rate, resolution accuracy, useful-intervention rate, and
  user-attention cost.

This phase changes no schema, prompt contract, MCP/CLI surface, or mutation permission.

### Phase B: Richer registered attention projection

- Extend or replace the narrow aggregate `finding_attention_state` through the registered projection
  contract, preserving its existing builder/invalidation semantics.
- Resolve active common findings against current tasks, projects, people, Calendar state, finding
  lifecycle events, and later findings.
- Derive a deliberately small first set of high-confidence signals: `untracked_user_commitment`,
  `waiting_on_other`, `commitment_at_risk`, `deadline_not_tracked`, and `duplicate_commitment`.
- Give every signal stable identity, sorted typed input provenance, builder version, date dependency
  where required, and a sanitized review representation.
- Feed only current bounded signal summaries into chief-of-staff and morning briefing; do not copy raw
  provider identifiers or evidence hashes.

Required tests include unchanged rebuild, finding-status invalidation, task/project removal,
date-boundary changes, cross-source duplicate suppression, later-evidence resolution, and sanitized
output. This phase should remain deterministic and make zero model calls.

### Phase C: Finding-vocabulary refinement

- Add `question_asked`, temporal status, completion/correction, and delegation semantics only where the
  Phase A corpus proves the existing kinds are insufficient.
- Update shared prompt contracts and both Gmail and Messages validators together under one
  orchestration owner.
- Add deterministic mappings for routine and high-confidence service traffic only after defining an
  evidence contract compatible with common findings.
- Keep Calendar deterministic; it supplies projection state and conflicts, not free-form model
  findings.
- Treat Telegram extraction as a separate provider integration requiring bounded refetch, privacy,
  evidence, stale-state, and no-retention work before it can contribute common findings.

### Phase D: Intervention planner

- Map each attention-signal type to a code-owned allowlist of possible intervention kinds.
- Rank silence, review, clarification, drafting, and proposal preparation separately from finding
  confidence.
- Implement inert drafts separately from typed effect plans and mutations.
- Reuse the architecture branch's finding-to-task proposal for eligible create-task interventions.
- Add any new effect type one at a time through the architecture's typed effect-plan work, with exact
  target policy, deterministic preview, hash binding, approval, backup, audit, undo, and stale-input
  rejection.

No generic action registry should be caller-extensible, and no suggested intervention should itself
authorize or select an executor.

### Phase E: Feedback and calibration

- Record attention-level dispositions: useful, not useful, already handled, incorrect, duplicate,
  irrelevant, too late, or too intrusive.
- Record intervention outcomes separately: surfaced, drafted, proposed, approved, rejected, applied,
  undone, expired, or resolved without action.
- Use feedback to tune presentation and suppression thresholds, never to weaken evidence, retention,
  policy, or authorization checks.
- Report usefulness by attention-signal type, presentation channel, and intervention level rather than
  only aggregate model or token metrics.

## Success criteria

The rework is successful when the system can demonstrate that it:

- surfaces a current obligation once and closes it when resolved;
- distinguishes “needs a reply” from “should become a task”;
- detects schedule changes and conflicts without inventing dates;
- connects incoming traffic to existing tasks, projects, people, and calendar state;
- suppresses routine, duplicate, stale, and already-recorded information;
- explains why an attention signal matters and which validated findings and projections support it;
- offers the smallest useful action and never treats a model suggestion as authorization;
- learns presentation preferences from explicit feedback while preserving hard safety boundaries;
- measures useful outcomes, false positives, duplicates, missed resolutions, and interruption cost;
- retains no forbidden source bodies, secrets, or unnecessarily identifying review data.

The north-star metric should be **useful resolved attention conditions per unit of user attention**,
with safety, grounding, and privacy as non-negotiable constraints. Task count, notification count,
extraction count, and model-call volume are not measures of value.
