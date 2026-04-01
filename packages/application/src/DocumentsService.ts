// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { VaultClient, type DocumentStore, type IDocumentMeta, type IVaultStorage } from '@savoire/platform'
import type { ActivatedVault, AppDocumentSummary, IDocumentsAPI, IVaultsBackend } from './contracts'
import { SyncOrchestrator } from './SyncOrchestrator'

type ActiveContext = ActivatedVault

export class DocumentsService implements IDocumentsAPI {
  private active: ActiveContext | null = null

  constructor(
    private readonly backend: IVaultsBackend,
    private readonly sync: SyncOrchestrator,
  ) {}

  async activateVault(params: {
    vaultId: string
    token: string
    storage: IVaultStorage
    documentStore: DocumentStore
    resolveDoc: (path: string) => IDocumentMeta | undefined
    onChanged: () => void
  }): Promise<ActivatedVault> {
    await this.disposeActiveVault()

    let hubRef: ActivatedVault['hub'] | null = null
    const s = params.storage
    const storageWithHub: IVaultStorage = {
      readFile:       (v, p, t)    => s.readFile(v, p, t),
      writeFile:      (v, p, c, t) => s.writeFile(v, p, c, t),
      resolveFileUrl: (v, p)       => s.resolveFileUrl(v, p),
      listDocuments:  (v, t)       => s.listDocuments(v, t),
      createFolder:   (v, p, t)    => s.createFolder(v, p, t),
      deleteFolder:   (v, p, t)    => s.deleteFolder(v, p, t),
      createDocument: async (_vaultId: string, path: string) => {
        if (!hubRef) throw new Error('Vault hub not attached')
        return hubRef.createDocument(path)
      },
      renameDocument: async (_vaultId: string, docId: string, path: string) => {
        if (!hubRef) throw new Error('Vault hub not attached')
        await hubRef.renameDocument(docId, path)
      },
      deleteDocument: async (_vaultId: string, docId: string) => {
        if (!hubRef) throw new Error('Vault hub not attached')
        await hubRef.deleteDocument(docId)
      },
      uploadAttachment: (v, f, t) => s.uploadAttachment(v, f, t),
      listFolders: (v, t) => s.listFolders(v, t),
    }

    const client = new VaultClient(
      params.vaultId,
      params.token,
      storageWithHub,
      params.documentStore,
      params.resolveDoc,
    )
    const hub = await this.sync.attachVaultSync(params.vaultId, client, params.onChanged)
    hubRef = hub
    void client.loadFolders()

    const active: ActiveContext = {
      vaultId: params.vaultId,
      client,
      hub,
      dispose: async () => {
        await hub.dispose()
      },
    }

    this.active = active
    return active
  }

  getActiveClient(): VaultClient | undefined {
    return this.active?.client
  }

  getActiveHub(): import('./contracts').VaultHubLike | null {
    return this.active?.hub ?? null
  }

  list(vaultId: string, token: string): Promise<AppDocumentSummary[]> {
    return this.backend.listDocuments(vaultId, token)
  }

  async disposeActiveVault(): Promise<void> {
    if (!this.active) return
    this.active = null
    await this.sync.disposeActive()
  }
}
