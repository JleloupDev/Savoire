// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { MetadataContributor } from '../IndexContributor'
import type { AnchorIndex } from '../AnchorIndex'

// Pattern C — singleton par document, pas dans le Y.Text.
// Appelé par IndexEngine.onPathChange() à l'ouverture ou au renommage.
// ID = `filename|${docId}` → un seul par doc, le second appel écrase le premier.

export class FilenameContributor implements MetadataContributor {
  readonly namespace = 'filename'

  processPath(docId: string, path: string, index: AnchorIndex): void {
    const basename = path.split('/').pop() ?? path
    const stem = basename.includes('.')
      ? basename.slice(0, basename.lastIndexOf('.'))
      : basename
    const id = `${this.namespace}|${docId}`
    index.add({ id, namespace: this.namespace, value: stem, docId })
  }
}
