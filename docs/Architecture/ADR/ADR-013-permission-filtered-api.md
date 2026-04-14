# ADR-013 — Permission Enforcement via PermissionFilteredAPI

## Status
In development — not fully enforced

## Context
Plugins declare required permissions in their manifest (e.g., `vault:read`, `vault:write`, `network:*`). Without enforcement, a plugin that declares `vault:read` can freely call `api.vault.write()` — the declaration is a lie with no consequence.

## Decision
`PermissionFilteredAPI` wraps the real `PluginAPI` and intercepts calls to restricted methods. If the calling plugin's manifest does not include the required permission, the call is blocked (throws or no-ops depending on severity).

This wrapper is applied when loading third-party plugins via `PluginSandbox`. Built-in (first-party) plugins currently receive the unfiltered API via `loadInternal()`.

## Current Limitations
- `PermissionFilteredAPI` exists but is only active on the third-party plugin path (`PluginSandbox`), which is not yet used in production.
- Built-in plugins are trusted and receive full API access regardless of their declared permissions.
- The permission model needs to be applied uniformly before opening the plugin system to third parties.

## Consequences (when fully enforced)
- Plugins cannot exceed their declared permissions.
- Security auditing is possible: manifest permissions are a contract, not a hint.
- Breaking change for any existing plugin that uses APIs beyond its declared permissions.
