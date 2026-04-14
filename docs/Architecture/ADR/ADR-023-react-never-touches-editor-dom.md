# ADR-023 — React Never Manages the Editor's Inner DOM

## Status
Accepted

## Context
EditorCore mounts a CodeMirror instance inside a container div. React and CodeMirror both want to own DOM mutations. If React re-renders the editor container, it may overwrite CodeMirror's internal DOM, causing visual glitches or state loss.

## Decision
The React wrapper (`Editor.tsx`) creates a single container div and passes it to `EditorCore.init()`. After that point, **React never touches the inner DOM**. The container div has a stable ref (`useRef`) — React renders it once and does not update its children.

EditorCore manages all internal DOM changes directly via CodeMirror's update mechanism.

## Consequences
- No React/CodeMirror DOM conflicts.
- The editor container cannot include React-managed children (e.g., overlays inside the editor area). Overlays are rendered via `createPortal` outside the container — see ADR-072.
- `Editor.tsx` is a thin mount/unmount wrapper; all editor behavior lives in `EditorCore`.
