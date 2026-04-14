# ADR-020 — Local Filesystem Fallback When No Blob Storage

## Status
Accepted

## Context
In production, file content (document bodies, attachments) is stored in Azure Blob Storage. In development or self-hosted deployments, requiring an Azure subscription or Azurite setup is a barrier to contribution.

## Decision
`ServiceCollectionExtensions` checks for a blob connection string at startup. If none is configured, it falls back to **`LocalFileContentStore`** — a filesystem implementation of the same `IContentStore` interface.

The switch is transparent to the Application layer: it always calls `IContentStore` methods regardless of the underlying storage.

## Consequences
- `docker-compose up` or `dotnet run` works out of the box with no cloud setup.
- Parity between local and cloud storage is validated by running against Azurite in CI (see Aspire configuration).
- Self-hosted deployments can run entirely on local disk — no Azure dependency required.
- The fallback uses the local filesystem path configured via `Database:Path` — data is persistent across restarts.
