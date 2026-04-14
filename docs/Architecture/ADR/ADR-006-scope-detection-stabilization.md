# ADR-006 — Plugin Scope Detection and Document Stabilization Timing

## Status
Accepted

## Context
Two timing decisions had to be made that directly affect plugin behavior and performance:

1. **Scope detection**: When the cursor moves, EditorCore re-evaluates which plugins are active for the current line (frontmatter-scoped plugins). Doing this on every cursor move is expensive.
2. **Document stabilization**: Plugins like the indexer and metadata extractor should not run on every keystroke — only when the user has stopped typing.

## Decision
- **Scope re-check is debounced at 1 second** after the cursor stops moving. Plugin thrashing (repeated load/unload cycles) is avoided when the user navigates quickly between lines.
- **`onDocumentStabilized` fires after 2 seconds of inactivity** (no document changes). This is the signal for plugins to perform expensive operations (indexing, metadata extraction, backlink updates).

## Consequences
- A plugin scoped to a specific section of a note activates ~1s after the cursor enters its scope. Acceptable UX tradeoff.
- Indexing lags up to 2s behind edits. Acceptable for search and backlinks; not suitable for real-time features.
- Both timers are per-EditorCore instance — multiple open tabs each maintain their own timers independently.
