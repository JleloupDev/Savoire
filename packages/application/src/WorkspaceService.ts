// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { VaultClient } from '@savoire/platform'
import type { VaultAPI } from '@savoire/plugin-api'
import type { IWorkspaceAPI } from './contracts'

export class WorkspaceService implements IWorkspaceAPI {
  createVaultProxy(
    getClient: () => VaultClient | undefined,
    resolveDocId: (path: string) => string | undefined,
  ): VaultAPI {
    return {
      read: (documentId: string) => getClient()?.read(documentId) ?? Promise.resolve(''),
      readDocumentByPath: (path: string) => getClient()?.readDocumentByPath(path) ?? Promise.resolve(''),
      write: (documentId: string, content: string) => getClient()?.write(documentId, content) ?? Promise.resolve(),
      list: (dir?: string) => getClient()?.list(dir) ?? Promise.resolve([]),
      exists: (documentId: string) => getClient()?.exists(documentId) ?? Promise.resolve(false),
      resolveDocumentId: (path: string) => resolveDocId(path),
      getVaultId: () => getClient()?.getVaultId() ?? '',
      getToken: () => getClient()?.getToken() ?? '',
      createFile: (path: string) => getClient()?.createFile?.(path) ?? Promise.resolve(),
      createFolder: (path: string) => getClient()?.createFolder?.(path) ?? Promise.resolve(),
      renameFile: (documentId: string, newPath: string) => getClient()?.renameFile?.(documentId, newPath) ?? Promise.resolve(),
      deleteFile: (documentId: string) => getClient()?.deleteFile?.(documentId) ?? Promise.resolve(),
      deleteFolder: (path: string) => getClient()?.deleteFolder?.(path) ?? Promise.resolve(),
      uploadAttachment: (file: File) => getClient()?.uploadAttachment?.(file) ?? Promise.reject(new Error('No active vault')),
      resolveAttachmentUrl: (path: string) => getClient()?.resolveAttachmentUrl?.(path) ?? '',
    }
  }
}
