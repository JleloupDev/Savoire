# ADR-016 — Metadata Widget Request Debounce

## Status
Accepted

## Context
`MetadataWidget` subscribes to `subscribeDocumentIndexed` to refresh metadata after each indexing pass. In development with HMR (Hot Module Replacement), multiple `EditorCore` instances can coexist briefly — each fires an indexing event for the same document, causing a burst of concurrent `GET /documents/{docId}/meta` requests.

Even in production, a single document save can trigger several indexing events in rapid succession (multiple contributors, multiple stabilization signals).

## Decision
The `subscribeDocumentIndexed` handler in `MetadataWidget` is **debounced at 300ms**. Multiple events within that window collapse into a single metadata fetch.

## Consequences
- Metadata display lags up to 300ms after indexing completes. Imperceptible to users.
- Eliminates request storms during HMR and multi-contributor indexing.
- The 300ms value is a pragmatic constant; it can be tuned without architectural changes.
