# ADR-021 — ILocalIndexStorage Behind an Interface

## Status
Accepted

## Context
Plugin index snapshots (backlinks, graph, tags) need to survive page reloads. The storage mechanism differs by environment: in-memory for tests, localStorage or IndexedDB for the web app, a local file for the desktop app.

## Decision
Index snapshot persistence is abstracted behind **`ILocalIndexStorage`**:

```ts
interface ILocalIndexStorage {
  saveSnapshot(namespace: string, data: string, seq: number): Promise<void>
  loadSnapshot(namespace: string): Promise<{ data: string; seq: number } | null>
}
```

`ContentIndexingService` and all `IndexContributor` plugins depend only on this interface. The concrete implementation is injected at the app level.

## Consequences
- Tests use `InMemoryIndexStorage` — no filesystem or browser APIs needed.
- The web app can swap between localStorage (simple) and IndexedDB (large vaults) without touching plugin code.
- Adding a new platform (e.g., native mobile) requires only a new adapter implementation.
- The interface is minimal by design — no listing, no expiry, no namespace enumeration. Extend only when needed.
