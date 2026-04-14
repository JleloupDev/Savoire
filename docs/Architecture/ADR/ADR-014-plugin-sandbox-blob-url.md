# ADR-014 — Third-Party Plugin Loading via Blob URL Dynamic Import

## Status
Accepted (infrastructure ready, not yet used in production)

## Context
Supporting user-installable third-party plugins requires loading plugin code that is not bundled at build time. Dynamic `import()` in browsers only accepts URLs, not arbitrary code strings. A mechanism is needed to bridge code strings to importable modules.

## Decision
`PluginSandbox` loads third-party plugin code using the **Blob URL pattern**:
1. Plugin code (as a string) is wrapped in a module shim.
2. A `Blob` is created from the code string, and a temporary URL is generated via `URL.createObjectURL()`.
3. `import(blobUrl)` loads the module dynamically.
4. The Blob URL is revoked immediately after import.
5. The plugin communicates its export via `globalThis.__poc_plugin__`.
6. The plugin receives a `PermissionFilteredAPI` based on its declared permissions.

## Current Limitations
All 17 built-in plugins bypass this mechanism entirely — they use `PluginLoader.loadInternal()`. `PluginSandbox` is unused in the current application.

The "sandbox" label is misleading: **there is no real isolation**. Plugin code runs in the same JavaScript context as the main app, with access to `window`, `document`, and `fetch`. The only protection is `PermissionFilteredAPI`. True sandboxing (Web Worker or iframe isolation) is planned as a future improvement.

## Consequences
- Enables future support for plugins loaded from URLs or user-provided code.
- `globalThis.__poc_plugin__` is a shared global — concurrent plugin loads would conflict. This needs revision before parallel loading is supported.
- The mechanism must be revisited alongside the broader plugin security model (Web Worker sandbox).
