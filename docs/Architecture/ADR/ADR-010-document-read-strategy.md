# ADR-010 — Two-Tier Document Read Strategy

## Status
Accepted

## Context
Plugins (note embeds, wikilinks) frequently need to read document content by path. A direct server call per read would be slow and generate unnecessary load, especially during indexing passes.

## Decision
Document reads are **cache-first**:
1. `VaultClient` in-memory cache is checked first (populated at vault open via the hub InitDocument snapshot).
2. On cache miss, the content is fetched from the server (CRDT op replay for `.md`, REST GET for other types).

The cache is invalidated on document rename, delete, or when a new version is received via SignalR.

## Consequences
- Embed rendering and backlink resolution are fast (in-memory).
- Cache can be stale for the brief window between a remote edit and the next CRDT update — acceptable for read-only embeds.
- Memory usage scales with vault size. Large vaults with thousands of documents may require eviction strategy (not yet implemented).
