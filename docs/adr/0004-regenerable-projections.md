# ADR 0004: Regenerable compact projections

Status: accepted

Obsidian Markdown remains canonical user knowledge. SQLite projections are disposable read models built by
a closed registry. Each builder declares name, version, state type, canonical input identities, and hashes.
The normalized dependency hash determines invalidation; unchanged inputs create no new state version.

Finding attention, project, person, task, chief-of-staff, calendar, and morning views are reproducible from
canonical sources and immutable operational records. Model recommendations are a separate bounded overlay.
Full and targeted rebuilds never rewrite human-authored journal prose.
