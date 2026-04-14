# ADR-011 — Workspace Owns Dockview via Port Interface

## Status
Accepted

## Context
Dockview is the panel layout library. If React components and plugins call Dockview APIs directly, replacing it (or testing without it) requires changes throughout the codebase.

## Decision
`WorkspaceRoot` is the **sole owner** of the `DockviewComponent`. All layout operations go through `WorkspaceManagerImpl` which implements the `WorkspaceAPI` interface. `DockviewAdapter` bridges `WorkspaceManagerImpl` to Dockview internals.

The conceptual model mirrors VS Code and Obsidian: **Panels** (left, center, right, bottom) contain **Views**, which contain **Widgets**. Plugins register Views via `api.views.register()` without knowing about Dockview.

## Consequences
- Dockview can be swapped for another layout engine by replacing `DockviewAdapter` only.
- Plugins are completely decoupled from the layout implementation.
- React components interact with the workspace via `WorkspaceAPI`, not Dockview events.
- Overlays (slash menu, bubble toolbar) must render via `createPortal` into `document.body` to escape Dockview's CSS transforms — see ADR-024.
