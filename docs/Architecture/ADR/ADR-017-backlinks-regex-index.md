# ADR-017 — Backlinks Indexed via Regex, Keyed by Target Path

## Status
Accepted

## Context
Backlinks (which notes link to the current note) need to be queryable in real time as the user edits. Options include: server-side SQL queries per request, or a client-side in-memory index maintained incrementally.

## Decision
`BacklinksIndexContributor` maintains an **in-memory index** on the client:
- Wikilinks are extracted via regex: `\[\[([^\]|]+)(?:\|[^\]]+)?\]\]`
- Index structure: `Map<targetPath, Map<docId, BacklinkEntry>>`
- Updates are O(1) per document: the inner map for a docId is replaced atomically on each `onOp` call.
- Lookup supports fuzzy matching: exact path match OR filename stem match (without extension).

The index is persisted as a JSON snapshot between sessions via `ILocalIndexStorage`.

## Consequences
- Backlink queries are O(1) — no server round-trip.
- Regex extraction misses complex cases (wikilinks in code blocks, escaped brackets). Acceptable for MVP.
- Index is rebuilt from scratch if the snapshot is missing or corrupt (on next stabilization cycle).
- The client holds a complete reverse-link graph in memory — scales reasonably for personal vaults, needs evaluation for large shared vaults.
