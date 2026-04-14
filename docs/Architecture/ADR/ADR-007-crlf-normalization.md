# ADR-007 — CRLF Normalization on Load

## Status
Accepted

## Context
Vault files may originate from Windows editors that produce `\r\n` line endings. CodeMirror 6 and Yjs both operate on `\n`-terminated strings internally. Mixed line endings cause subtle bugs: line length calculations are off by one, regex patterns fail on line boundaries, and Yjs position mapping produces incorrect offsets.

## Decision
All document content is normalized from `\r\n` to `\n` at load time, before being passed to `EditorCore.init()`. Content written back to the vault is stored as `\n` regardless of the host platform.

## Consequences
- The editor always works with a consistent line ending model.
- Files originally created with `\r\n` on Windows will be silently converted on first save. This is intentional and expected for a cross-platform vault.
- No special casing needed in any other part of the editor or plugin code.
