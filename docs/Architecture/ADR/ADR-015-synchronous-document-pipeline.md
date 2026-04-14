# ADR-015 — Synchronous Document Pipeline

## Status
Accepted

## Context
Document processing involves multiple stages: frontmatter extraction, metadata parsing, hook execution (beforeParse, afterRender). These could be async (awaiting each plugin hook) or sync.

## Decision
The document pipeline (`DocumentPipeline`) is **synchronous by design**. Hook stages run in order; each hook receives the output of the previous one. Async indexing and side effects are deferred to the `onDocumentStabilized` event (2s after last edit), which runs outside the pipeline.

## Consequences
- Pipeline execution is predictable and fast — no async boundary in the hot path.
- Plugins cannot perform async operations inside `beforeParse` or `afterRender` hooks.
- Heavy work (network calls, indexing, file reads) must be deferred to `onDocumentStabilized` or registered as separate event listeners.
- The pipeline can be tested synchronously without async test utilities.
