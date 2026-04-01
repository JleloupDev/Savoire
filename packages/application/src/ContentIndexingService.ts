// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { HookRegistry, IIndexRegistry } from '@savoire/plugin-api'
import type { ILocalIndexStorage } from '@savoire/platform'
import type { VaultHubLike } from './contracts'

/**
 * ContentIndexingService — abonné à onDocumentStabilized, dispatche aux IndexContributors.
 *
 * see ADR-015
 *
 * Cycle de vie :
 *   1. restore()       — au démarrage, recharge les snapshots persistés
 *   2. init()          — s'abonne au hook (appeler après que les plugins ont chargé)
 *   3. attachHub(hub)  — appelé après activation du vault, branche la sync serveur
 */
export class ContentIndexingService {
  private getHub: (() => VaultHubLike | null) | null = null
  private hubUnsubscribe: (() => void) | null = null
  private onIndexed: ((docId: string, path: string) => void) | null = null

  constructor(
    private readonly hooks: HookRegistry,
    private readonly indexRegistry: IIndexRegistry,
    private readonly storage: ILocalIndexStorage,
  ) {}

  /** Callback appelé après chaque indexation locale (pour notifier les panels). */
  setOnIndexed(cb: (docId: string, path: string) => void): void {
    this.onIndexed = cb
  }

  /** Recharge les snapshots depuis le stockage. Appeler avant init(). */
  async restore(): Promise<void> {
    for (const contributor of this.indexRegistry.getAll()) {
      const saved = await this.storage.loadSnapshot(contributor.namespace)
      if (saved) {
        contributor.restore(saved.data, saved.seq)
        console.debug(`[ContentIndexingService] restored "${contributor.namespace}" at seq=${saved.seq}`)
      }
    }
  }

  /** S'abonne à onDocumentStabilized. Appeler après que les plugins ont chargé. */
  init(): void {
    this.hooks.onDocumentStabilized(async (docId, path, content) => {
      // 1. Applique localement avec seq=null (op non encore séquencée)
      for (const contributor of this.indexRegistry.getAll()) {
        contributor.onOp(null, docId, path, content)
        const snap = contributor.snapshot()
        await this.storage.saveSnapshot(contributor.namespace, snap, contributor.processedSeq)
      }

      // 2. Notifie les panels (backlinks, metadata) que ce doc a été ré-indexé
      this.onIndexed?.(docId, path)

      // 3. Pousse au serveur pour séquencement et broadcast aux autres clients
      const hub = this.getHub?.()
      if (hub?.pushIndexOp) {
        void hub.pushIndexOp(docId, path, content)
      }
    })
  }

  /**
   * Branche la sync serveur. Appelé après activation du vault.
   * Le hub est consulté via getHub() à chaque op (pas capturé à l'enregistrement)
   * pour éviter des refs périmées après changement de vault.
   */
  attachHub(getHub: () => VaultHubLike | null): void {
    // Nettoie l'abonnement précédent si on change de vault
    this.hubUnsubscribe?.()
    this.hubUnsubscribe = null
    this.getHub = getHub

    // Subscribe aux ops des autres clients
    const hub = getHub()
    if (hub?.onIndexOpApplied) {
      this.hubUnsubscribe = hub.onIndexOpApplied((evt) => {
        for (const contributor of this.indexRegistry.getAll()) {
          contributor.onOp(evt.seq, evt.docId, evt.path, evt.markdownContent)
        }
        // Pas de saveSnapshot ici — le seq final sera persisté lors de la prochaine op locale
      })
    }
  }

  detachHub(): void {
    this.hubUnsubscribe?.()
    this.hubUnsubscribe = null
    this.getHub = null
  }

  /**
   * Indexe immédiatement un contenu shadow pré-converti.
   * Utilisé par les FileViews non-Markdown (Excalidraw, etc.) via onFileContentStabilized.
   * Le contenu est déjà en Markdown (shadow document) — pas de contentExtractor ici.
   */
  async indexNow(docId: string, path: string, shadowMarkdown: string): Promise<void> {
    for (const contributor of this.indexRegistry.getAll()) {
      contributor.onOp(null, docId, path, shadowMarkdown)
      const snap = contributor.snapshot()
      await this.storage.saveSnapshot(contributor.namespace, snap, contributor.processedSeq)
    }
    const hub = this.getHub?.()
    if (hub?.pushIndexOp) {
      void hub.pushIndexOp(docId, path, shadowMarkdown)
    }
  }
}
