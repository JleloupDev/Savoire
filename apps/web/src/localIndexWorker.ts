// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Worker de l'index local du navigateur (ADR-027, etape 6) : SQLite
// WebAssembly, persiste dans l'OPFS (VFS opfs-sahpool), un fichier par vault.
// Le fil principal lui parle par messages (WorkerLocalIndex, localIndex.ts).
import { serveWasmIndex } from '@savoire/indexer-core/wasm'

serveWasmIndex(self as unknown as Parameters<typeof serveWasmIndex>[0])
