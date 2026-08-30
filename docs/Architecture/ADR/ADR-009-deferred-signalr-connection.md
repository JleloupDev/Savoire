# ADR-009 — Deferred SignalR Connection via setTimeout(0)

## Status
Superseded by ADR-026

## Context
React 18 StrictMode double-invokes effects in development. `EditorCore.init()` starts the SignalR connection in a `useEffect`. In StrictMode, the effect runs, then immediately runs the cleanup (dispose), then runs again. If the connection starts synchronously, the first connect + immediate disconnect leaves the SignalR client in an error state before the second mount completes.

## Decision
The SignalR connection start is deferred via `setTimeout(0)`. This pushes it to the next event loop tick, after the synchronous StrictMode cleanup has run. The deferred connect is cancelled if `dispose()` is called before the timeout fires.

## Consequences
- EditorCore behaves correctly under React StrictMode double-invocation.
- Negligible latency impact (~0ms in practice — just a microtask boundary).
- This is a React-specific workaround and should be revisited if EditorCore is used outside React or if StrictMode behavior changes.
