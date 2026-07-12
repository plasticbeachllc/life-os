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
  -> bounded subscription-agent extraction
  -> sanitized extraction review
  -> user selects extraction ID + item index
  -> yellow task proposal
  -> exact preview and target-hash validation
  -> short-lived approval token
  -> atomic inbox append + backup + undo record
```

### Proposal construction

`proposeEmailExtractionTask` accepts only an extraction ID and item index. It rejects missing items,
non-user ownership, and kinds other than `explicit_request`, `open_loop`, or `user_commitment`.

Life OS, not the agent, derives:

- task text from the validated extraction statement;
- due date from the structured extraction;
- a stable `task_*` ID;
- the fixed target `00 Inbox/Inbox.md`;
- source and target hashes;
- the exact review preview.

The agent cannot supply a path, patch, task body, due date, or task ID.

### Application

`applyEmailTaskProposal` rechecks all important boundaries after approval:

- proposal workflow and tool identity;
- approved lifecycle state;
- fixed canonical inbox path;
- deterministic `create_task` policy decision;
- vault-root containment;
- unchanged target hash;
- task-line and task-ID shape.

It copies the current inbox to the external backup directory, writes a temporary sibling file, renames
it atomically, records before/after hashes, and creates an undo record. The appended provenance comment
links the stable task to the extraction without retaining an email body.

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

The API request uses `singleEvents=true`, `orderBy=startTime`, and `showDeleted=true`. Pagination is
bounded by Google's event-list response and continues until `nextPageToken` is absent.

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

The integration adds three tools:

| Tool | Effect |
| --- | --- |
| `life_os_calendar_status` | Metadata-only configured/event/unprocessed counts. |
| `life_os_ingest_calendar` | Read-only provider ingestion and compact-state rebuild. |
| `life_os_propose_email_task` | Creates a pending fixed-inbox proposal; does not write. |

Task application continues through the shared tools:

1. `life_os_get_proposal`
2. `life_os_prepare_proposal_approval`
3. explicit user approval
4. `life_os_apply_approved_proposal`
5. optional `life_os_prepare_undo` and `life_os_undo_action`

## Schema

Schema version 8 adds:

- `calendar_accounts`
- `calendar_ingestion_runs`
- `calendar_events`

Email task proposals reuse the existing runs, proposals, actions, approvals, authorization tokens,
action results, backups, and undo records.

## Verification

The live primary-calendar check completed with five changed events on the first run and five unchanged
events on the second run. Calendar status reported zero unprocessed events.

The first email-task proposal was approved as an end-to-end test. It appended a Walmart+ decision task,
created an external backup, recorded extraction provenance, and rebuilt into compact task state without
validation errors.

Automated coverage includes incremental Calendar replay, compact-state non-retention, fixed task target,
owner/kind eligibility, no-write proposal construction, approved atomic application, stable task ID and
provenance parsing, and the MCP tool allowlist.

## Known Follow-Up Work

- Reconcile events that disappear from the active window without returning as canceled records.
- Record failed Calendar ingestion runs after a run has started.
- Add explicit review feedback for proposed email tasks before using acceptance-rate metrics.
- Add provider sync tokens only if measured API volume justifies them.
