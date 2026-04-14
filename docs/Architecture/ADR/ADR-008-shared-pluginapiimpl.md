# ADR-008 — Single Shared PluginAPIImpl Across All Tabs

## Status
Accepted

## Context
Opening multiple documents in tabs could naively trigger a full plugin load cycle per tab — registering the same blocks, views, and hooks multiple times, leading to duplicate slash commands, conflicting block detectors, and memory leaks.

## Decision
`PluginAPIImpl` (and all registries) is created **once per session** and shared across all tabs. Plugins load once via `PluginLoader.loadInternal()`. Per-note activation is handled at the rendering layer: `LivePreview` and `BlockRegistry.getActive(ids)` filter the registered specs by the active plugin ids for the current note, without unloading and reloading plugins.

## Consequences
- Plugin `onload()` runs once; `onunload()` runs at session end.
- Activation state is a lightweight in-memory filter, not a lifecycle event.
- Plugins cannot maintain per-tab state via their `onload` closure — they must use the provided APIs or external stores.
- Simplifies debugging: plugin state is consistent across all open tabs.
