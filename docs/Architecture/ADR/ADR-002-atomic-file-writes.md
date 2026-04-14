# ADR-002 — Atomic File Writes

## Status
Accepted

## Context
The application stores vault documents as files on disk (or blob storage). A direct overwrite (`File.WriteAllText`) is not safe: if the process crashes mid-write, the file is partially written and unrecoverable. For a note-taking app, silent data corruption is a critical failure.

## Decision
All content writes use a **write-then-rename** pattern:
1. Write the new content to a temporary file in the same directory.
2. On success, atomically rename the temp file over the target path.

Rename is a single filesystem operation — it either completes fully or not at all. The original file is never in a partially-written state.

## Consequences
- File content is always either the previous version or the new version. Never corrupt.
- Slightly higher I/O (two filesystem operations instead of one).
- Implemented in both `LocalFileContentStore` and `AzureBlobContentStore`.
