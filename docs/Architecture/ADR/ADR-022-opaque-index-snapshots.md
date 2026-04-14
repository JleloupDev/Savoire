# ADR-022 — Index Snapshots Are Opaque to the Server

## Status
Accepted

## Context
Plugins maintain their own index state (backlinks map, graph edges, tag counts). This state needs to be persisted server-side so it survives client restarts and can be shared across clients. The server could either understand the schema of each plugin's state, or store it as an opaque blob.

## Decision
The server stores plugin index snapshots as **opaque JSON blobs**, keyed by `(vaultId, namespace)`. It has no knowledge of the schema inside. Clients push and pull snapshots via `PUT /index-snapshots/{namespace}` and `GET /index-snapshots/{namespace}`.

The server tracks only `processedSeq` (the last operation sequence number incorporated into the snapshot) to detect staleness.

## Consequences
- Plugins can evolve their snapshot schema without server changes.
- The server cannot query or transform plugin index data — it is a dumb store.
- Cross-client snapshot sharing requires clients to agree on the snapshot schema for a given namespace (enforced by the plugin version in the manifest).
- Server-side search cannot use plugin indexes directly — a future FTS solution must be implemented separately in the server layer.
