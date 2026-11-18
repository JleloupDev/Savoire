# Savoire

A local-first, p2p-ready, self-hostable knowledge platform for teams. Write in Markdown, collaborate in real time, extend with plugins.

Features :
https://github.com/user-attachments/assets/042153b0-1037-48ac-8f67-654fd9e89cc2

Sync :
https://github.com/user-attachments/assets/8bbb736f-fbc2-4625-b60f-250be6ab2bf4


## Why?

Most knowledge tools make you choose: powerful or open, collaborative or local, extensible or self-hostable.

Savoire doesn't make you choose. It's fully open-source, works offline, syncs when you're connected, and runs on your own infrastructure.

## What it does

- **Markdown editor** with live preview — headings, code blocks, tables, callouts, task lists, embeds
- **Real-time collaboration** — changes merge automatically using CRDTs (conflict-free replicated data types)
- **Topology-agnostic sync** — all features work locally first; sync kicks in when a server is available
- **Wikilinks and backlinks** — link notes with `[[note name]]`, see what links back
- **Plugin system** — extend with new editors, file formats, views, and commands
- **Self-hostable** — one `docker-compose up` and you're running

## Current state

The project is between POC and MVP. Core sync, real-time collaboration, and the plugin architecture are working. Some features listed below are still in progress.

## Getting started

**Requirements:** Rust (stable, 1.88+), PostgreSQL, Node.js 20+, pnpm

```bash
# Dependencies (PostgreSQL, Zitadel)
docker compose -f deploy/compose/docker-compose.dev.yml up -d --wait

# Backend
cd backend
SAVOIRE_ENVIRONMENT=Development cargo run

# Frontend (separate terminal)
cd frontend
pnpm install
pnpm dev:web
```

Open `http://localhost:3000`. The frontend proxies API calls to the backend automatically.

## Project structure

```
backend/                   Rust server (axum, sqlx, PostgreSQL)
  src/api/                 HTTP API
  src/realtime/            Real-time hubs (WebSocket)
  src/access.rs            Access control (members, inherited ACLs, share links)
  src/db/                  Persistence and schema migrations
  tests/                   Integration tests (PostgreSQL)

apps/
  web/                     Web app
  desktop/                 Desktop app
  editor-dev/              Editor development harness
  view/                    Read-only viewer

packages/
  editor-core/             Core editor logic
  editor-react/            React bindings
  plugin-api/              Public plugin contract
  plugin-runtime/          Plugin loader and lifecycle
  plugins/                 All built-in plugins
  domain-sync/             Sync domain model
  infrastructure-sync/     Sync transport (Yjs + real-time hubs)
  realtime-client/         Client of the server's real-time hubs (WebSocket)
  platform/                Platform abstractions
  workspace/               Vault and workspace management
  ui-components/           Shared UI components

infra/                     Azure Bicep deployment templates
docs/                      Architecture docs and ADRs
tests/                     Backend and frontend test suites
```

## Architecture

The backend follows Clean Architecture. Domain logic stays isolated from infrastructure. The frontend uses a plugin API: plugins depend only on a public contract, never on internals.

Real-time sync uses [Yjs](https://yjs.dev) (CRDT) over SignalR for Markdown documents. Non-Markdown files use a last-write-wins snapshot model.

## Built-in plugins

All major features are intentionally built as plugins. Some of these plugins could be marked as core later.

| Plugin | What it does |
|--------|-------------|
| plugin-filetree | File browser panel |
| plugin-wikilinks | `[[wikilink]]` navigation |
| plugin-backlinks | Shows which notes link to the current one |
| plugin-graph | Visual graph of note connections |
| plugin-callout | Callout blocks (`> [!NOTE]`) |
| plugin-code-block | Syntax-highlighted code blocks |
| plugin-table | Editable tables with formula support |
| plugin-excalidraw | Embedded drawings (`.excalidraw` files) |
| plugin-mermaid | Diagrams as code |
| plugin-mindmap | Mind maps as a first-class format |
| plugin-note-embed | Embed notes and images inline (`![[...]]`) |

## License

[AGPL-3.0](LICENSE)
