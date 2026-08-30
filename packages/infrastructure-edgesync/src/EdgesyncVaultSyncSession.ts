// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Adapte EdgesyncVaultSession au port commun IVaultSyncSession, exactement
// comme SavoireServerVaultSession le fait pour le profil serveur. C'est ici,
// et nulle part dans l'application, que vit la specificite du protocole.
//
// Note de portabilite : EdgesyncVaultSession attend qu'on lui REMETTE un Y.Doc
// deja construit. Ce wrapper absorbe cette difference en creant lui-meme le
// YjsCrdtAdapter, ce qui est precisement ce que le port exige. Un connecteur
// automerge-repo n'aurait pas cette gymnastique a faire : c'est son `Repo` qui
// produit le document, donc il implementerait openDocument() directement.
import type { ICRDT } from '@savoire/plugin-api'
import type { IVaultDirectory } from '@savoire/platform'
import type { IVaultSyncSession, IKeyManagedVaultSession } from '@savoire/application'
import { YjsCrdtAdapter, YMapVaultDirectory } from '@savoire/infrastructure-sync'
import { EdgesyncVaultSession } from './EdgesyncVaultSession'

export interface EdgesyncVaultSyncSessionOptions {
  vaultId: string
  identitySeed: Uint8Array
  getToken: () => string | null
  getVaultKey: () => Uint8Array | null
  onChanged: () => void
}

export class EdgesyncVaultSyncSession implements IVaultSyncSession, IKeyManagedVaultSession {
  private readonly crdts = new Map<string, YjsCrdtAdapter>()
  private readonly unsubDirectory: () => void

  private constructor(
    readonly directory: IVaultDirectory,
    private readonly inner: EdgesyncVaultSession,
    onChanged: () => void,
  ) {
    this.unsubDirectory = directory.onChange(onChanged)
  }

  static async open(
    opts: EdgesyncVaultSyncSessionOptions,
    openInner: (directory: YMapVaultDirectory) => Promise<EdgesyncVaultSession>,
  ): Promise<EdgesyncVaultSyncSession> {
    const directory = new YMapVaultDirectory()
    const inner = await openInner(directory)
    return new EdgesyncVaultSyncSession(directory, inner, opts.onChanged)
  }

  openDocument(docId: string): ICRDT {
    const existing = this.crdts.get(docId)
    if (existing) return existing
    const crdt = new YjsCrdtAdapter()
    this.crdts.set(docId, crdt)
    // 3e argument : les curseurs pairs voyagent sur le meme canal chiffre
    // (EdgesyncAwarenessChannel) que le contenu.
    this.inner.openDocument(docId, crdt.rawDoc, crdt)
    return crdt
  }

  closeDocument(docId: string): void {
    const crdt = this.crdts.get(docId)
    if (!crdt) return
    this.crdts.delete(docId)
    this.inner.closeDocument(docId)
    crdt.dispose()
  }

  getState(): 'connected' | 'connecting' | 'disconnected' {
    return 'connected'
  }

  // ── Extras d'un protocole a cles (detectes par isKeyManagedSession) ────────

  get isOwner(): boolean { return this.inner.isOwner }
  get isGranting(): boolean { return this.inner.isGranting }
  renewVaultKey(): Promise<void> { return this.inner.renewVaultKey() }
  debugVaultKey(): { epoch: number; base64: string } | undefined { return this.inner.debugVaultKey() }
  debugDocKey(docId: string): string | undefined { return this.inner.debugDocKey(docId) }

  async dispose(): Promise<void> {
    this.unsubDirectory()
    for (const docId of [...this.crdts.keys()]) this.closeDocument(docId)
    await this.inner.dispose()
    this.directory.dispose()
  }
}
