// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type * as Y from 'yjs'
import type { IndexContributor, MetadataContributor } from './IndexContributor'
import { AnchorIndex } from './AnchorIndex'

// Simule le rôle de ContentIndexingService pour le POC.
// Dans Savoire, c'est ContentIndexingService qui orchestre les appels.

export class IndexEngine {
  readonly index = new AnchorIndex()
  private readonly contributors: IndexContributor[] = []
  private readonly metadataContributors: MetadataContributor[] = []

  register(contributor: IndexContributor): this {
    this.contributors.push(contributor)
    return this
  }

  registerMetadata(contributor: MetadataContributor): this {
    this.metadataContributors.push(contributor)
    return this
  }

  // Appelé par l'observer Y.Text (temps réel).
  onYjsChange(ytext: Y.Text, ydoc: Y.Doc, docId: string): void {
    for (const c of this.contributors) {
      c.onYjsChange?.(ytext, ydoc, docId, this.index)
    }
    this.index.markValidated(docId)
  }

  // Appelé après stabilisation ou depuis le serveur (flux existant).
  onOp(seq: number | null, docId: string, path: string, markdownContent: string): void {
    for (const c of this.contributors) {
      c.onOp(seq, docId, path, markdownContent)
    }
  }

  // Appelé à l'ouverture d'un doc ou sur renommage.
  onPathChange(docId: string, path: string): void {
    for (const c of this.metadataContributors) {
      c.processPath(docId, path, this.index)
    }
  }
}
