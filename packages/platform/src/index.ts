// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
export type {
  IDocumentMeta, IDocumentFetcher, IVaultStorage, ILocalIndexStorage, IVaultDirectory,
  DocumentSyncKind, ISnapshotDocument, IVaultFiles, IVaultContentSession,
} from './ports'
export { documentSyncKind } from './ports'
export type { OpenDocument } from './DocumentStore'
export { DocumentStore } from './DocumentStore'
export { VaultClient } from './VaultClient'
export { InMemoryIndexStorage, LocalStorageIndexStorage } from './LocalIndexStorage'
