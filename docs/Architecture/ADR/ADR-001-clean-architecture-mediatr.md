# ADR-001 — Clean Architecture with MediatR

## Status
Accepted

## Context
The backend needs a clear separation between transport (HTTP, SignalR) and business logic. Without explicit boundaries, hubs and controllers tend to accumulate logic over time, making testing and evolution harder.

## Decision
All business logic lives in the Application layer as MediatR commands and queries. Hubs and controllers are thin dispatchers — they receive input, send a MediatR message, and return the result. Domain events are published as `INotification`; hub handlers subscribe and broadcast to clients without any knowledge of domain internals.

## Consequences
- Hubs and controllers stay under ~20 lines per action.
- Business logic is testable without HTTP or SignalR.
- Adding a new transport (e.g., gRPC) requires no changes to Application or Domain.
- MediatR adds indirection — tracing a request requires following the pipeline.
