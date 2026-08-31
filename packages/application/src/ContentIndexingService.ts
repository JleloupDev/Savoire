// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { HookRegistry, IIndexRegistry, IIndexChannel } from '@savoire/plugin-api'
import type { CrdtVersion, SharedIndexEntry } from '@savoire/domain-index'
import { isSharedContributor } from '@savoire/domain-index'
import type { ILocalIndexStorage } from '@savoire/platform'
import type { IVaultSyncSession } from './contracts'

/**
 * ContentIndexingService — possede les canaux d'index et fait le pont entre
 * les documents et les contributeurs.
 *
 * see ADR-015
 *
 * Deux familles de contributeurs cohabitent :
 *
 *  - PARTAGES (isSharedContributor) : le service ouvre un canal CRDT par
 *    namespace, y ecrit les entrees calculees par le contributeur, et lui
 *    renvoie l'etat complet a chaque changement — local ou distant. Le
 *    contributeur ne connait ni transport, ni persistance, ni sequencement.
 *
 *  - LOCAUX : `fulltext` uniquement, qui reste sur l'ancien modele
 *    snapshot/restore persiste dans le navigateur. Voir LocalIndexContributor.
 *
 * Aucun etat d'index ne transite plus vers le serveur sous forme
 * interpretable : les canaux relaient des trames CRDT opaques.
 *
 * Cycle de vie :
 *   1. init()                       — s'abonne au hook (apres chargement des plugins)
 *   2. switchVault(storage, session) — a chaque activation de vault
 */
export class ContentIndexingService {
  private readonly channels = new Map<string, IIndexChannel>()
  private readonly channelUnsubs: (() => void)[] = []
  private onIndexed: ((docId: string, path: string) => void) | null = null

  constructor(
    private readonly hooks: HookRegistry,
    private readonly indexRegistry: IIndexRegistry,
    private storage: ILocalIndexStorage,
  ) {}

  /** Callback invoque apres chaque passe d'indexation locale (pour les panneaux). */
  setOnIndexed(cb: (docId: string, path: string) => void): void {
    this.onIndexed = cb
  }

  /**
   * Rebranche tout sur un nouveau vault : instances de contributeurs neuves,
   * stockage local du vault, canaux partages de sa session.
   */
  async switchVault(
    storage: ILocalIndexStorage,
    getSession?: () => IVaultSyncSession | null | undefined,
  ): Promise<void> {
    this.closeChannels()
    this.storage = storage
    this.indexRegistry.rebuild()
    await this.restoreLocal()
    if (getSession) this.openChannels(getSession)
  }

  /** Recharge les snapshots des contributeurs LOCAUX uniquement. */
  private async restoreLocal(): Promise<void> {
    for (const contributor of this.indexRegistry.getAll()) {
      if (isSharedContributor(contributor)) continue
      const saved = await this.storage.loadSnapshot(contributor.namespace)
      if (saved) contributor.restore(saved.data, saved.seq)
    }
  }

  /** Ouvre un canal par contributeur partage et l'y abonne. */
  private openChannels(getSession: () => IVaultSyncSession | null | undefined): void {
    const session = getSession()
    if (!session) return
    for (const contributor of this.indexRegistry.getAll()) {
      if (!isSharedContributor(contributor)) continue
      const channel = session.openIndex(contributor.namespace)
      this.channels.set(contributor.namespace, channel)
      const feed = (): void => {
        const byDoc = new Map<string, SharedIndexEntry[]>()
        for (const { id, value } of channel.getAll()) {
          byDoc.set(id, (value as SharedIndexEntry[] | undefined) ?? [])
        }
        contributor.onEntriesChanged(byDoc)
        // Un pair distant a modifie l'index : les panneaux doivent se rafraichir.
        this.onIndexed?.('', '')
      }
      this.channelUnsubs.push(channel.onChange(feed))
      feed() // etat deja presente au moment de l'ouverture
    }
  }

  private closeChannels(): void {
    for (const unsub of this.channelUnsubs) unsub()
    this.channelUnsubs.length = 0
    for (const channel of this.channels.values()) channel.dispose()
    this.channels.clear()
  }

  /** S'abonne a onDocumentStabilized. A appeler apres le chargement des plugins. */
  init(): void {
    this.hooks.onDocumentStabilized(async (docId, path, content, crdtVersion?: CrdtVersion) => {
      await this.indexDocument(docId, path, content, crdtVersion)
      this.onIndexed?.(docId, path)
    })
  }

  /**
   * Indexe un contenu markdown deja converti (documents non-Markdown :
   * Excalidraw, etc., via onFileContentStabilized).
   */
  async indexNow(docId: string, path: string, shadowMarkdown: string): Promise<void> {
    await this.indexDocument(docId, path, shadowMarkdown)
    this.onIndexed?.(docId, path)
  }

  /** Oublie un document supprime, dans tous les namespaces partages. */
  forgetDocument(docId: string): void {
    for (const channel of this.channels.values()) channel.delete(docId)
  }

  private async indexDocument(
    docId: string,
    path: string,
    content: string,
    crdtVersion?: CrdtVersion,
  ): Promise<void> {
    for (const contributor of this.indexRegistry.getAll()) {
      if (isSharedContributor(contributor)) {
        // Une seule ecriture par document : le canal est clefe par documentId,
        // donc « recalculer ce document » remplace exactement ses entrees.
        this.channels.get(contributor.namespace)?.set(
          docId,
          contributor.computeEntries(docId, path, content),
        )
        continue
      }
      contributor.onOp(null, docId, path, content)
      if (crdtVersion && 'updateCrdtVersion' in contributor) {
        (contributor as unknown as { updateCrdtVersion(d: string, v: CrdtVersion): void })
          .updateCrdtVersion(docId, crdtVersion)
      }
      await this.storage.saveSnapshot(
        contributor.namespace, contributor.snapshot(), contributor.processedSeq,
      )
    }
  }
}
