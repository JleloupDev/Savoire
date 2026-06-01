// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { VaultClient, type DocumentStore, type IDocumentMeta, type IVaultDirectory, type IVaultStorage } from '@savoire/platform'
import type { ActivatedVault, AppDocumentSummary, IDocumentsAPI, IVaultsBackend, VaultHubLike } from './contracts'
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
    directory: IVaultDirectory
    resolveDoc: (path: string) => IDocumentMeta | undefined
    onChanged: () => void
  }): Promise<ActivatedVault> {
    await this.disposeActiveVault()

    const s = params.storage
    const storageWithHub: IVaultStorage = {
      readFile:         (v, p, t)    => s.readFile(v, p, t),
      writeFile:        (v, p, c, t) => s.writeFile(v, p, c, t),
      resolveFileUrl:   (v, p)       => s.resolveFileUrl(v, p),
      listDocuments:    (v, t)       => s.listDocuments(v, t),
      createFolder:     (v, p, t)    => s.createFolder(v, p, t),
      deleteFolder:     (v, p, t)    => s.deleteFolder(v, p, t),
      uploadAttachment: (v, f, t)    => s.uploadAttachment(v, f, t),
      listFolders:      (v, t)       => s.listFolders(v, t),
    }

    const client = new VaultClient(
      params.vaultId,
      params.token,
      storageWithHub,
      params.documentStore,
      params.directory,
      params.resolveDoc,
    )
    const hub = await this.sync.attachVaultSync(params.vaultId, client, params.onChanged)
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

  /**
   * Activates a single shared document without connecting to the vault hub.
   * Used when the caller has document-level ACL but is not a vault member.
   * The VaultClient is pre-seeded with the one known document; all write
   * operations on the stub storage throw read-only errors.
   * see ADR-027
   */
  async activateSharedDocument(params: {
    vaultId: string
    doc: IDocumentMeta
    token: string
    documentStore: DocumentStore
    directory: IVaultDirectory
    resolveDoc: (path: string) => IDocumentMeta | undefined
  }): Promise<ActivatedVault> {
    await this.disposeActiveVault()

    const d = params.doc
    const readOnly = async (): Promise<never> => { throw new Error('read-only shared document') }
    const stubStorage: IVaultStorage = {
      listDocuments:   async ()       => [d],
      listFolders:     async ()       => [],
      readFile:        async ()       => '',
      writeFile:       readOnly,
      resolveFileUrl:  ()             => '',
      createDocument:  readOnly,
      renameDocument:  readOnly,
      deleteDocument:  readOnly,
      createFolder:    readOnly,
      deleteFolder:    readOnly,
      uploadAttachment: readOnly,
    }

    const client = new VaultClient(
      params.vaultId,
      params.token,
      stubStorage,
      params.documentStore,
      params.directory,
      params.resolveDoc,
    )
    client.addDocument(d)

    const nullHub: VaultHubLike = {
      connect:        async () => {},
      dispose:        async () => {},
      createDocument: readOnly,
      renameDocument: readOnly,
      deleteDocument: readOnly,
    }

    const active: ActivatedVault = {
      vaultId: params.vaultId,
      client,
      hub: nullHub,
      dispose: async () => {},
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
