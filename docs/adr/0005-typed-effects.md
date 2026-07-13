# ADR 0005: Typed effects and exact authorization

Status: accepted

Effects form a closed discriminated union with code-owned executors. A proposal stores its validated plan,
plan hash, executor version, immutable source identity, target path, and expected target hash. Callers never
select an executor or submit generic paths, patches, commands, URLs, SQL, or filesystem arguments.

Executor-owned review is shared by CLI, MCP, and UI sanitizers. Policy and source/target currency are checked
when preparing authorization and again when consuming it. Tokens are short-lived, single-use, and bound to
proposal, action, target hash, plan hash, and executor version. Writes are atomic, backed up, audited, and
undoable only while the post-action target hash remains current.
