// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { VaultClient, type DocumentStore, type IDocumentMeta, type IVaultDirectory, type IVaultStorage } from '@savoire/platform'
import type { ActivatedVault, ActivateVaultParams, IDocumentsAPI, IEdgesyncVaultSessionFactory, EdgesyncVaultSessionLike, VaultHubLike } from './contracts'
import { SyncOrchestrator } from './SyncOrchestrator'

type ActiveContext = ActivatedVault

export class DocumentsService implements IDocumentsAPI {
  private active: ActiveContext | null = null

  constructor(
    private readonly sync: SyncOrchestrator,
    private readonly edgesyncFactory: IEdgesyncVaultSessionFactory,
  ) {}

  async activateVault(params: ActivateVaultParams): Promise<ActivatedVault> {
    await this.disposeActiveVault()

    const s = params.storage
    const storageWithHub: IVaultStorage = {
      readFile:         (v, p, t)    => s.readFile(v, p, t),
      writeFile:        (v, p, c, t) => s.writeFile(v, p, c, t),
      resolveFileUrl:   (v, p)       => s.resolveFileUrl(v, p),
      listDocuments:    (v, t)       => s.listDocuments(v, t),
      uploadAttachment: (v, f, t)    => s.uploadAttachment(v, f, t),
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
    const edgesyncVault = await this.edgesyncFactory.open({
      vaultId: params.vaultId,
      identitySeed: params.identitySeed,
      directory: params.directory,
      isManaged: params.isManaged,
    })
    // The directory's own CRDT observer is the source of truth for "the note
    // list changed" — local edits AND remote ops applied via the edgesync
    // Session both go through it. Previously VaultHubClient called onChanged
    // after applying an incoming op; now that the directory syncs via
    // EdgesyncVaultSession instead, nothing else fires it for remote changes.
    const unsubDirectoryChange = params.directory.onChange(params.onChanged)

    const active: ActiveContext = {
      vaultId: params.vaultId,
      client,
      hub,
      edgesyncVault,
      dispose: async () => {
        unsubDirectoryChange()
        await edgesyncVault.dispose()
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
      listDocuments:    async ()       => [d],
      readFile:         async ()       => '',
      writeFile:        readOnly,
      resolveFileUrl:   ()             => '',
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
      connect: async () => {},
      dispose: async () => {},
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

  getActiveEdgesyncVault(): EdgesyncVaultSessionLike | undefined {
    return this.active?.edgesyncVault
  }

  async disposeActiveVault(): Promise<void> {
    if (!this.active) return
    const active = this.active
    this.active = null
    // Close the edgesync vault session directly (not via active.dispose(),
    // which also disposes the hub — that's sync.disposeActive()'s job below,
    // and it additionally clears SyncOrchestrator's own bookkeeping). Awaited:
    // a subsequent activateVault() must not race ahead of this connection
    // actually closing.
    await active.edgesyncVault?.dispose()
    await this.sync.disposeActive()
  }
}
