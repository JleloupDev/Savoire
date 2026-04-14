# ADR-019 — SQLite with WAL Mode

## Status
Accepted

## Context
The backend uses SQLite as its metadata store. SQLite's default journal mode (DELETE) uses exclusive write locks — concurrent reads are blocked while a write is in progress. For a collaborative editor where reads (document list, metadata) and writes (index updates, operation log) happen simultaneously, this causes contention.

## Decision
SQLite is configured in **Write-Ahead Logging (WAL) mode**. In WAL mode, readers never block writers and writers never block readers. Multiple readers can operate concurrently with an active write.

## Consequences
- Read and write operations proceed concurrently without blocking each other.
- WAL introduces a second file (`.db-wal`) alongside the main database — backup procedures must include it.
- WAL mode is persistent — it survives application restarts.
- Performance is improved for read-heavy workloads (metadata queries, document listing). Write throughput is similar to DELETE mode.
