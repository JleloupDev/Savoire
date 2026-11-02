// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Entree WebAssembly du noyau d'indexation : @savoire/indexer-core/wasm.
// A charger dans un Worker (navigateur) ou dans Node (tests, en memoire) :
// jamais dans le fil principal, qui passe par WorkerLocalIndex (/local).
export { WasmSqliteDriver } from './WasmSqliteDriver'
export type { WasmSqliteOptions } from './WasmSqliteDriver'
export { openWasmDatabase, removeWasmDatabase, loadSqlite, indexFileName, POOL_NAME, POOL_DIRECTORY } from './open'
export type { WasmOpenResult } from './open'
export { openWasmLocalIndex, serveWasmIndex } from './worker'
