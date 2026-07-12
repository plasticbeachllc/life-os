export const schemaVersion = 7;

export const ddl = [
  `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    workflow TEXT NOT NULL,
    mode TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    status TEXT NOT NULL,
    agent_version TEXT,
    prompt_version TEXT,
    model_version TEXT,
    created_at TEXT NOT NULL
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS actions (
    action_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id),
    tool_name TEXT NOT NULL,
    lifecycle_state TEXT NOT NULL,
    permission_class TEXT NOT NULL,
    target_entity_id TEXT,
    target_path TEXT,
    source_hash TEXT,
    target_hash TEXT,
    arguments_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS action_results (
    result_id INTEGER PRIMARY KEY AUTOINCREMENT,
    action_id TEXT NOT NULL REFERENCES actions(action_id),
    run_id TEXT NOT NULL REFERENCES runs(run_id),
    ok INTEGER NOT NULL,
    message TEXT NOT NULL,
    files_modified_json TEXT NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS file_versions (
    path TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    modified_at TEXT NOT NULL,
    indexed_at TEXT NOT NULL
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS workflow_state (
    workflow TEXT PRIMARY KEY,
    state_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS change_events (
    change_id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    previous_hash TEXT,
    relevant_section_hashes_json TEXT NOT NULL,
    changed_at TEXT NOT NULL,
    processed_at TEXT,
    UNIQUE(source_type, source_id, content_hash)
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS derived_states (
    state_id TEXT PRIMARY KEY,
    state_type TEXT NOT NULL,
    entity_id TEXT,
    state_version INTEGER NOT NULL,
    content_json TEXT NOT NULL,
    source_hashes_json TEXT NOT NULL,
    generation_method TEXT NOT NULL,
    prompt_version TEXT,
    model TEXT,
    created_at TEXT NOT NULL,
    superseded_at TEXT,
    UNIQUE(state_type, entity_id, state_version)
  )
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_derived_states_current
  ON derived_states(state_type, entity_id, superseded_at)
  `,
  `
  CREATE TABLE IF NOT EXISTS model_calls (
    call_id TEXT PRIMARY KEY,
    run_id TEXT REFERENCES runs(run_id),
    workflow TEXT NOT NULL,
    task_type TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    source_hash TEXT,
    context_hash TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cached_tokens INTEGER,
    cached INTEGER NOT NULL DEFAULT 0,
    estimated_cost REAL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    status TEXT NOT NULL,
    error TEXT
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS context_manifests (
    manifest_id TEXT PRIMARY KEY,
    call_id TEXT REFERENCES model_calls(call_id),
    included_items_json TEXT NOT NULL,
    omitted_items_json TEXT NOT NULL,
    token_budget_json TEXT NOT NULL,
    retrieval_levels_json TEXT NOT NULL,
    ranking_version TEXT NOT NULL,
    context_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS model_cache (
    cache_key TEXT PRIMARY KEY,
    workflow TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    model TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    context_hash TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    output_json TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    created_at TEXT NOT NULL,
    expires_at TEXT
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS summary_versions (
    summary_id TEXT PRIMARY KEY,
    summary_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    summary_hash TEXT NOT NULL,
    prompt_version TEXT,
    model TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(summary_type, source_id, source_hash, prompt_version)
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS retrieval_events (
    retrieval_id TEXT PRIMARY KEY,
    call_id TEXT REFERENCES model_calls(call_id),
    source_id TEXT NOT NULL,
    retrieval_level INTEGER NOT NULL CHECK(retrieval_level BETWEEN 0 AND 3),
    reason TEXT NOT NULL,
    token_estimate INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS proposals (
    proposal_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id),
    workflow TEXT NOT NULL,
    mode TEXT NOT NULL,
    lifecycle_state TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    target_path TEXT NOT NULL,
    target_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT,
    applied_at TEXT,
    UNIQUE(workflow, target_path, target_hash)
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS approvals (
    approval_id INTEGER PRIMARY KEY AUTOINCREMENT,
    proposal_id TEXT NOT NULL REFERENCES proposals(proposal_id),
    action_id TEXT NOT NULL REFERENCES actions(action_id),
    approved_at TEXT NOT NULL,
    UNIQUE(proposal_id, action_id)
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS rejections (
    rejection_id INTEGER PRIMARY KEY AUTOINCREMENT,
    proposal_id TEXT NOT NULL REFERENCES proposals(proposal_id),
    action_id TEXT NOT NULL REFERENCES actions(action_id),
    reason TEXT NOT NULL,
    rejected_at TEXT NOT NULL,
    UNIQUE(proposal_id, action_id)
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS undo_records (
    undo_id INTEGER PRIMARY KEY AUTOINCREMENT,
    action_id TEXT NOT NULL REFERENCES actions(action_id),
    target_path TEXT NOT NULL,
    backup_path TEXT NOT NULL,
    before_hash TEXT NOT NULL,
    after_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    undone_at TEXT
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS briefing_feedback (
    feedback_id INTEGER PRIMARY KEY AUTOINCREMENT,
    state_id TEXT NOT NULL REFERENCES derived_states(state_id),
    item_key TEXT NOT NULL,
    useful INTEGER NOT NULL,
    recorded_at TEXT NOT NULL,
    UNIQUE(state_id, item_key)
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS authorization_tokens (
    token_hash TEXT PRIMARY KEY,
    purpose TEXT NOT NULL CHECK(purpose IN ('apply_proposal', 'undo_action')),
    proposal_id TEXT,
    action_id TEXT NOT NULL,
    expected_target_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS gmail_accounts (
    account_id TEXT PRIMARY KEY,
    email_address TEXT,
    selection_label_id TEXT NOT NULL,
    last_history_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS gmail_ingestion_runs (
    ingestion_run_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES gmail_accounts(account_id),
    started_at TEXT NOT NULL,
    completed_at TEXT,
    status TEXT NOT NULL,
    discovered_count INTEGER NOT NULL DEFAULT 0,
    ingested_count INTEGER NOT NULL DEFAULT 0,
    unchanged_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    error TEXT
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS gmail_threads (
    account_id TEXT NOT NULL REFERENCES gmail_accounts(account_id),
    thread_id TEXT NOT NULL,
    thread_state_hash TEXT NOT NULL,
    ordered_message_ids_json TEXT NOT NULL,
    latest_message_id TEXT NOT NULL,
    latest_internal_date TEXT NOT NULL,
    message_count INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(account_id, thread_id)
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS gmail_messages (
    account_id TEXT NOT NULL REFERENCES gmail_accounts(account_id),
    message_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    internal_date TEXT NOT NULL,
    from_address TEXT,
    to_addresses_json TEXT NOT NULL,
    cc_addresses_json TEXT NOT NULL,
    subject TEXT,
    rfc_message_id TEXT,
    selected_important INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    current_version_hash TEXT NOT NULL,
    last_processed_hash TEXT,
    last_extraction_hash TEXT,
    ingestion_state TEXT NOT NULL,
    first_ingested_at TEXT NOT NULL,
    last_ingested_at TEXT NOT NULL,
    PRIMARY KEY(account_id, message_id)
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS gmail_message_versions (
    account_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    headers_hash TEXT NOT NULL,
    normalized_body_hash TEXT NOT NULL,
    authored_body_hash TEXT NOT NULL,
    quoted_body_hash TEXT NOT NULL,
    normalizer_version TEXT NOT NULL,
    body_character_count INTEGER NOT NULL,
    authored_character_count INTEGER NOT NULL,
    quoted_character_count INTEGER NOT NULL,
    discovered_at TEXT NOT NULL,
    PRIMARY KEY(account_id, message_id, content_hash),
    FOREIGN KEY(account_id, message_id) REFERENCES gmail_messages(account_id, message_id)
  )
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_gmail_messages_thread
  ON gmail_messages(account_id, thread_id, internal_date)
  `,
  `
  CREATE TABLE IF NOT EXISTS gmail_extractions (
    extraction_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    thread_state_hash TEXT NOT NULL,
    call_id TEXT NOT NULL REFERENCES model_calls(call_id),
    classification TEXT NOT NULL,
    output_json TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    model TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(account_id, message_id, source_hash, prompt_version, schema_version, policy_version),
    FOREIGN KEY(account_id, message_id) REFERENCES gmail_messages(account_id, message_id)
  )
  `,
];
