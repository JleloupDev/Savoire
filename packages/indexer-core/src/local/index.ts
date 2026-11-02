// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Index local des clients complets (bureau, navigateur) :
// @savoire/indexer-core/local. Sans SQLite : les pilotes sont dans les
// entrees /wasm (navigateur, Worker) et /tauri (bureau).
export { DirectLocalIndex } from './LocalIndex'
export type { ILocalIndex, LocalIndexInfo, LocalPersistence, DirectLocalIndexOptions } from './LocalIndex'
export { SourceTable, SOURCES_TABLE } from './sources'
export { serveLocalIndex, WorkerLocalIndex } from './rpc'
export type { MessagePortLike, LocalOpenRequest, LocalIndexOpener, WorkerLocalIndexOptions } from './rpc'
export { SharedIndexFeeder, metaRecord, metaSignature } from './SharedIndexFeeder'
export type { SharedNote, SharedIndexFeederOptions } from './SharedIndexFeeder'
export { BaseRowFeeder } from './BaseRowFeeder'
export type { RowDoc } from './BaseRowFeeder'
export { shortHash } from './hash'
