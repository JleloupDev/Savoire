# ADR-012 — Plugins Loaded Once Per Session, Activation Computed Per Note

## Status
Accepted

## Context
There are two ways to handle per-note plugin scoping: (A) unload and reload plugins when the active note changes, or (B) keep all plugins loaded and filter their contributions at render time.

Option A gives plugins clean lifecycle boundaries but creates expensive load/unload cycles on every tab switch. Option B requires the rendering layer to understand which plugins are active.

## Decision
All plugins are loaded **once at session start** via `PluginLoader.loadInternal()`. The activation map (which plugin ids are active for the current note) is recomputed on each note open by `PluginActivationResolver`, reading the note's frontmatter and file extension.

`LivePreview` and `BlockRegistry.getActive(ids)` use this map to filter which block specs and decorations are applied — without triggering plugin lifecycle events.

## Consequences
- Tab switching is fast: no plugin load/unload, only a lightweight map recomputation.
- Plugins cannot react to "I became active for this note" — they have no activation callback. This is intentional; scope-aware behavior must be implemented via block detection logic.
- A plugin with `defaultActive: false` still runs `onload()` once and registers its specs globally — they are simply filtered out for notes that don't activate it.
