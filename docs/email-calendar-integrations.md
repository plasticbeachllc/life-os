# Email and Calendar Integrations

This document describes the implemented Gmail-to-task and Google Calendar read-only integrations.
Both integrations share Google desktop OAuth but retain separate provider adapters, stores, workflows,
and safety boundaries.

## Permissions

The OAuth flow requests exactly:

```text
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/calendar.readonly
```

The loopback callback binds a random state value and PKCE verifier. Google client credentials are
resolved from 1Password into the narrow process environment. The refresh token is managed by the
existing desktop credential adapter. Neither integration can write to Google.

## Gmail to Task

Gmail ingestion and structured extraction remain separate from task creation:

```text
IMPORTANT Gmail message
  -> deterministic ingestion and hashes
  -> metadata-only extraction work item
  -> exclusive bounded lease + exact refetch
  -> bounded subscription-agent extraction
  -> sanitized extraction review
  -> deterministic common finding projection
  -> user selects active finding
  -> yellow task proposal
  -> exact preview and target-hash validation
  -> short-lived approval token
  -> atomic inbox append + backup + undo record
```

### Proposal construction

`proposeFindingTask` accepts only a finding ID. It rejects missing or inactive findings, non-user
ownership, and kinds other than `explicit_request`, `open_loop`, or `user_commitment`.

Life OS, not the agent, derives:

- task text from the validated finding statement;
- due date from the structured extraction;
- a stable `task_*` ID;
- the fixed target `00 Inbox/Inbox.md`;
- immutable finding-content and target hashes;
- the exact review preview.

The agent cannot supply a path, patch, task body, due date, or task ID.

### Extraction work

Changed Gmail messages enqueue extraction work in the same SQLite transaction as message, thread, and
immutable-version metadata. Unchanged replay emits nothing. Preparation atomically leases one work
item and binds its source/container identity into the context manifest. Extraction, common findings,
model-call completion, and work completion commit together. Work items retain internal identities and
hashes but never Gmail bodies, excerpts, prompt blobs, or raw errors.

### Application

`applyFindingTaskProposal` rechecks all important boundaries after approval:

- proposal workflow and tool identity;
- approved lifecycle state;
- fixed canonical inbox path;
- deterministic `create_task` policy decision;
- vault-root containment;
- unchanged target hash;
- active finding status and unchanged finding content hash;
- task-line and task-ID shape.

It copies the current inbox to the external backup directory, writes a temporary sibling file, renames
it atomically, records before/after hashes, and creates an undo record. The appended provenance comment
links the stable task to the finding without retaining an email body. Successful application records a
`converted` finding status in the same SQLite transaction as action and undo metadata; undo appends an
`active` status event.

## Calendar

Version 1 reads the primary Google Calendar only. The default window is one day in the past through
30 days in the future.

```text
Google Calendar API
  -> primary calendar metadata
  -> paginated, expanded event instances
  -> deterministic event normalization and hashes
  -> SQLite upsert for changed events only
  -> compact calendar_state projection
```

The API request uses `singleEvents=true`, `orderBy=startTime`, and `showDeleted=true`. Each invocation
is bounded by a 30-second wall-clock budget, 10 pages, and a configurable event-instance limit
(`life-os calendar ingest --limit <n>`, default 500, maximum 5,000). When a budget is reached, LifeOS
persists the exact Calendar page token and fixed query window, returns a terminal `partial` run, and
resumes that same window on the next invocation. The cursor is cleared only after `nextPageToken` is absent.

### Retention

Calendar SQLite rows retain only:

- provider event ID and calendar ID;
- status;
- title;
- optional location;
- start and end;
- all-day flag;
- provider update timestamp;
- deterministic content and processed hashes;
- ingestion timestamps.

Descriptions, attendees, organizers, conference links, attachments, reminders, and provider response
bodies are not represented by the adapter and are not stored.

### Delta and compact state

The normalized content hash includes status, title, location, time range, and all-day state. An event
with the same hash is counted unchanged and not rewritten. A successful projection marks the exact
included event hashes processed.

`calendar_state` contains:

```json
{
  "as_of": "timestamp",
  "window_end": "timestamp",
  "event_count": 5,
  "next_events": []
}
```

There is deliberately no event-density or calendar-pressure heuristic. Calendar state is independently
queryable through `life_os_list_compact_state` with `stateType: "calendar"`.

## MCP Surface

Relevant integration and shared tools include:

| Tool | Effect |
| --- | --- |
| `life_os_calendar_status` | Metadata-only configured/event/unprocessed counts. |
| `life_os_ingest_calendar` | Read-only provider ingestion and compact-state rebuild. |
| `life_os_propose_finding_task` | Creates a pending fixed-inbox proposal from one eligible active finding; does not write. |
| `life_os_work_status` | Sanitized aggregate extraction backlog and oldest pending age. |

Task application continues through the shared tools:

1. `life_os_get_proposal`
2. `life_os_prepare_proposal_approval`
3. explicit user approval
4. `life_os_apply_approved_proposal`
5. optional `life_os_prepare_undo` and `life_os_undo_action`

## Schema

Schema version 8 originally added:

- `calendar_accounts`
- `calendar_ingestion_runs`
- `calendar_events`

Finding task proposals reuse the existing runs, proposals, actions, approvals, authorization tokens,
action results, backups, and undo records.

Schema version 17 adds the shared Gmail/Messages `work_items` queue. Older prototype databases require
an explicit reset and rebuild; Life OS never deletes them automatically.

## Verification

The live primary-calendar check completed with five changed events on the first run and five unchanged
events on the second run. Calendar status reported zero unprocessed events.

The first finding-task proposal was approved as an end-to-end test. It appended a decision task,
created an external backup, recorded finding provenance, and rebuilt into compact task state without
validation errors.

Automated coverage includes incremental Calendar replay, compact-state non-retention, fixed task target,
owner/kind eligibility, no-write proposal construction, approved atomic application, stable task ID and
provenance parsing, and the MCP tool allowlist.

## Known Follow-Up Work

- Reconcile events that disappear from the active window without returning as canceled records.
- Add explicit review feedback for proposed finding tasks before using acceptance-rate metrics.
- Add provider sync tokens only if measured API volume justifies them.
