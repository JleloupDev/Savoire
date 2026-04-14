# ADR-005 — StateField for Live Preview Block Rendering

## Status
Accepted

## Context
CodeMirror 6 offers two extension types for UI customization: `ViewPlugin` (imperative, runs after each view update) and `StateField` (declarative, part of the editor state). Live preview needs to replace markdown block syntax with rendered widgets using `Decoration.replace({ block: true })`.

## Decision
Live preview uses a **StateField** to compute and store block decorations, not a ViewPlugin.

Block-level decorations that replace content (as opposed to mark decorations) require the decoration set to be part of the editor state, not the view layer. ViewPlugin decorations are not considered during state transitions — they can cause layout inconsistencies and missed invalidations when `block: true` replacements are involved.

## Consequences
- Decoration computation is pure and deterministic — given a document state, the same decorations are always produced.
- State transitions correctly invalidate block widgets when their source content changes.
- Slightly higher overhead than ViewPlugin for simple cases, acceptable for the block rendering use case.
