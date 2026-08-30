// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Profil serveur Savoire : le serveur relaie et persiste les ops en clair.
// Implemente IVaultSyncSession, exactement comme le connecteur EdgeSync et
// comme le ferait un futur connecteur automerge-repo/Beelay.
//
// C'est ici que vivent les `new` qui etaient jusqu'ici codes en dur dans
// apps/web : YMapVaultDirectory, YjsCrdtAdapter, SignalRTransport. Changer de
// protocole se fait en changeant de fabrique de session, sans toucher l'app.
import type { ICRDT, IIdentityProvider } from '@savoire/plugin-api'
import type { IVaultDirectory } from '@savoire/platform'
import type { IVaultSyncSession, VaultSyncSessionFactoryParams } from '@savoire/application'
import { CollabOrchestrator } from '@savoire/application'
import { YMapVaultDirectory } from './YMapVaultDirectory'
import { YjsCrdtAdapter } from './YjsCrdtAdapter'
import { SignalRTransport } from './SignalRTransport'
import { VaultHubClient } from './VaultHubClient'

interface OpenDoc {
  crdt: YjsCrdtAdapter
  transport: SignalRTransport
  orchestrator: CollabOrchestrator
}

export interface SavoireServerVaultSessionOptions extends VaultSyncSessionFactoryParams {
  serverUrl?: string
  getToken: () => string | null
}

export class SavoireServerVaultSession implements IVaultSyncSession {
  readonly directory: IVaultDirectory
  private readonly docs = new Map<string, OpenDoc>()
  private readonly hub: VaultHubClient
  private readonly unsubDirectory: () => void

  private constructor(
    private readonly opts: SavoireServerVaultSessionOptions,
    directory: IVaultDirectory,
    hub: VaultHubClient,
  ) {
    this.directory = directory
    this.hub = hub
    // Le repertoire est la source de verite du « la liste a change » : les
    // edits locaux comme les ops distantes appliquees par le hub y passent.
    this.unsubDirectory = directory.onChange(opts.onChanged)
  }

  static async open(opts: SavoireServerVaultSessionOptions): Promise<SavoireServerVaultSession> {
    const directory = new YMapVaultDirectory()
    const hub = new VaultHubClient(
      opts.serverUrl ?? '',
      opts.vaultId,
      directory,
      opts.onChanged,
      opts.getToken,
      opts.onConnectionChange,
    )
    const session = new SavoireServerVaultSession(opts, directory, hub)
    await hub.connect()
    return session
  }

  openDocument(docId: string): ICRDT {
    const existing = this.docs.get(docId)
    if (existing) return existing.crdt

    const identity: IIdentityProvider | undefined = this.opts.identity
    if (!identity) throw new Error('SavoireServerVaultSession requires an identity provider to sign ops')

    const crdt = new YjsCrdtAdapter()
    const transport = new SignalRTransport({
      serverUrl: this.opts.serverUrl ?? '',
      userId: this.opts.userId,
      getToken: this.opts.getToken,
    })
    const orchestrator = new CollabOrchestrator(crdt, transport, identity)
    this.docs.set(docId, { crdt, transport, orchestrator })
    void transport.join(this.opts.vaultId, docId)
    return crdt
  }

  closeDocument(docId: string): void {
    const open = this.docs.get(docId)
    if (!open) return
    this.docs.delete(docId)
    open.orchestrator.dispose()
    void open.transport.disconnect()
    open.crdt.dispose()
  }

  getState(): 'connected' | 'connecting' | 'disconnected' {
    // Le hub du vault porte le repertoire ; l'etat d'un document suit le sien.
    return this.hub.isConnected ? 'connected' : 'disconnected'
  }

  pushIndexOp(docId: string, path: string, markdownContent: string): Promise<number | null> {
    return this.hub.pushIndexOp(docId, path, markdownContent)
  }

  onIndexOpApplied(cb: (evt: { seq: number; docId: string; path: string; markdownContent: string }) => void): () => void {
    return this.hub.onIndexOpApplied(cb)
  }

  async dispose(): Promise<void> {
    this.unsubDirectory()
    for (const docId of [...this.docs.keys()]) this.closeDocument(docId)
    await this.hub.dispose()
    this.directory.dispose()
  }
}
