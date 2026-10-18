// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
export type {
  IDocumentMeta, IDocumentFetcher, IVaultStorage, ILocalIndexStorage, IVaultDirectory,
  DocumentSyncKind, ISnapshotDocument, IVaultFiles, IVaultContentSession,
  FileUploadOptions, AttachmentPlacement,
} from './ports'
export { documentSyncKind } from './ports'
export type { OpenDocument } from './DocumentStore'
export { DocumentStore } from './DocumentStore'
export { VaultClient } from './VaultClient'
export {
  ATTACHMENTS_DIR, sanitizeFileName,
  uniqueAttachmentPath, resolveLinkPath, linkTargetFor,
  ATTACHMENT_LOCATION, ATTACHMENT_EXTENSIONS, isAttachmentPath,
  noteFolderOf, attachmentFolderFor, folderNoteOf,
} from './attachments'
export type { AttachmentLocation } from './attachments'
export { UploadTracker, uploadTracker, subscribeUploads, uploadErrorReason } from './uploads'
export type { UploadEvent, UploadReport } from './uploads'
export { InMemoryIndexStorage, LocalStorageIndexStorage } from './LocalIndexStorage'
export { TRASH_DIR, isTrashPath, trashPathFor, originalPathOf, restorePathFor } from './trash'
export type { IVaultFileSystem, FileEntry, FileChange } from './fileSystem'
export { InMemoryVaultFileSystem } from './InMemoryVaultFileSystem'
export type { InMemoryVaultFileSystemOptions } from './InMemoryVaultFileSystem'
