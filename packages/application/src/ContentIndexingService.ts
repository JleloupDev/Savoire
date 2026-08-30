// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { HookRegistry, IIndexRegistry } from '@savoire/plugin-api'
import type { CrdtVersion } from '@savoire/domain-index'
import type { ILocalIndexStorage } from '@savoire/platform'
import type { IVaultSyncSession } from './contracts'

/**
 * ContentIndexingService — subscribes to onDocumentStabilized and dispatches to IndexContributors.
 *
 * see ADR-015
 *
 * Lifecycle:
 *   1. restore()       — on startup, reloads persisted snapshots
 *   2. init()          — subscribes to the hook (call after plugins have loaded)
 *   3. attachHub(getSession) — apres activation d'un vault, branche la synchro d'index
 */
export class ContentIndexingService {
  private getHub: (() => IVaultSyncSession | null | undefined) | null = null
  private hubUnsubscribe: (() => void) | null = null
  private onIndexed: ((docId: string, path: string) => void) | null = null

  constructor(
    private readonly hooks: HookRegistry,
    private readonly indexRegistry: IIndexRegistry,
    private storage: ILocalIndexStorage,
  ) {}

  /** Swaps storage, rebuilds fresh contributor instances, and reloads snapshots for the new vault. */
  async switchVault(storage: ILocalIndexStorage): Promise<void> {
    this.storage = storage
    this.indexRegistry.rebuild()
    await this.restore()
  }

  /** Callback invoked after each local indexing pass (to notify panels). */
  setOnIndexed(cb: (docId: string, path: string) => void): void {
    this.onIndexed = cb
  }

  /** Reloads snapshots from storage. Call before init(). */
  async restore(): Promise<void> {
    for (const contributor of this.indexRegistry.getAll()) {
      const saved = await this.storage.loadSnapshot(contributor.namespace)
      if (saved) {
        contributor.restore(saved.data, saved.seq)
        console.debug(`[ContentIndexingService] restored "${contributor.namespace}" at seq=${saved.seq}`)
      }
    }
  }

  /** Subscribes to onDocumentStabilized. Call after plugins have loaded. */
  init(): void {
    this.hooks.onDocumentStabilized(async (docId, path, content, crdtVersion?: CrdtVersion) => {
      // 1. Apply locally with seq=null (op not yet sequenced)
      for (const contributor of this.indexRegistry.getAll()) {
        contributor.onOp(null, docId, path, content)
        if (crdtVersion && 'updateCrdtVersion' in contributor) {
          (contributor as { updateCrdtVersion(docId: string, version: CrdtVersion): void }).updateCrdtVersion(docId, crdtVersion)
        }
        const snap = contributor.snapshot()
        await this.storage.saveSnapshot(contributor.namespace, snap, contributor.processedSeq)
      }

      // 2. Notify panels (backlinks, metadata) that this doc was re-indexed
      this.onIndexed?.(docId, path)

      // 3. Push to server for sequencing and broadcast to other clients
      const hub = this.getHub?.()
      if (hub?.pushIndexOp) {
        void hub.pushIndexOp(docId, path, content)
      }
    })
  }

  /**
   * Wires server sync. Called after vault activation.
   * The hub is queried via getHub() on each op (not captured at registration time)
   * to avoid stale refs after a vault switch.
   */
  attachHub(getHub: () => IVaultSyncSession | null | undefined): void {
    // Clear previous subscription when vault changes
    this.hubUnsubscribe?.()
    this.hubUnsubscribe = null
    this.getHub = getHub

    const hub = getHub()
    if (hub?.onIndexOpApplied) {
      this.hubUnsubscribe = hub.onIndexOpApplied((evt: { seq: number; docId: string; path: string; markdownContent: string }) => {
        for (const contributor of this.indexRegistry.getAll()) {
          contributor.onOp(evt.seq, evt.docId, evt.path, evt.markdownContent)
        }
        // No saveSnapshot here — final seq is persisted on the next local op
      })
    }
  }

  detachHub(): void {
    this.hubUnsubscribe?.()
    this.hubUnsubscribe = null
    this.getHub = null
  }

  /**
   * Immediately indexes pre-converted shadow content.
   * Used by non-Markdown FileViews (Excalidraw, etc.) via onFileContentStabilized.
   * Content is already in Markdown (shadow document) — no contentExtractor here.
   */
  async indexNow(docId: string, path: string, shadowMarkdown: string, pushToHub = true): Promise<void> {
    for (const contributor of this.indexRegistry.getAll()) {
      contributor.onOp(null, docId, path, shadowMarkdown)
      const snap = contributor.snapshot()
      await this.storage.saveSnapshot(contributor.namespace, snap, contributor.processedSeq)
    }
    if (pushToHub) {
      const hub = this.getHub?.()
      if (hub?.pushIndexOp) void hub.pushIndexOp(docId, path, shadowMarkdown)
    }
  }

}
