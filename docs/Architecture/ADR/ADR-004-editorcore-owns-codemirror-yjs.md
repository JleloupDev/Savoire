# ADR-004 — EditorCore Owns CodeMirror and Yjs

## Status
Accepted

## Context
The editor stack involves CodeMirror 6 (text editing), Yjs (CRDT), and SignalR (sync transport). These three need tight coordination — Yjs binds directly to the CM6 `EditorView`, and SignalR must apply updates to the same Y.Doc. Multiple owners would require complex synchronization between them.

## Decision
`EditorCore` is the sole owner of the CM6 `EditorView` and the Yjs `Y.Doc`. All interactions go through its public API (`init`, `setContent`, `getContent`, `dispose`, `on`). No external code holds a reference to these internal objects.

## Consequences
- Lifecycle is clear: create → init → use → dispose.
- React wrapper (`editor-react`) creates a container div and hands it to EditorCore; React never touches the editor's inner DOM.
- Testing EditorCore requires no React or DOM environment for logic tests.
- Plugins cannot directly manipulate the CM6 state — they go through the block/hook registry APIs.
