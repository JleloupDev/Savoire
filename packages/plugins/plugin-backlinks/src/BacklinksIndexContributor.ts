// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { IndexContributor, SharedIndexEntry } from '@savoire/plugin-api'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BacklinkEntry {
  /** UUID du document source. */
  docId: string
  /** Chemin vault-relatif du document source. */
  path: string
}

// ─── Wikilink extraction ──────────────────────────────────────────────────────

// see ADR-017
const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g

function extractWikilinks(content: string): string[] {
  const targets: string[] = []
  let m: RegExpExecArray | null
  WIKILINK_RE.lastIndex = 0
  while ((m = WIKILINK_RE.exec(content)) !== null) {
    targets.push(m[1].trim())
  }
  return targets
}

// ─── BacklinksIndexContributor ────────────────────────────────────────────────

/**
 * Maintient l'index des backlinks en mémoire.
 *
 * Structure : Map<targetPath, BacklinkEntry[]>
 *   - targetPath : chemin ou titre wikilink (ex. "s1.md" ou "My Note")
 *   - BacklinkEntry : { docId, path } du document source
 *
 * see ADR-017
 */
export class BacklinksIndexContributor implements IndexContributor {
  readonly namespace = 'backlinks'

  // Map<cible, Map<docId source, entree>> — modele de lecture reconstruit
  // depuis la carte partagee.
  // see ADR-017
  private readonly index = new Map<string, Map<string, BacklinkEntry>>()

  computeEntries(_docId: string, path: string, markdown: string): SharedIndexEntry[] {
    const targets = [...new Set(extractWikilinks(markdown))]
    if (targets.length === 0) return []
    return [{ key: 'targets', value: { path, targets } }]
  }

  onEntriesChanged(byDoc: ReadonlyMap<string, SharedIndexEntry[]>): void {
    this.index.clear()
    for (const [docId, entries] of byDoc) {
      const entry = entries.find(e => e.key === 'targets')
      if (!entry) continue
      const { path, targets } = entry.value as { path: string; targets: string[] }
      for (const target of targets) {
        let inner = this.index.get(target)
        if (!inner) { inner = new Map(); this.index.set(target, inner) }
        inner.set(docId, { docId, path })
      }
    }
  }

  getBacklinks(targetPath: string): BacklinkEntry[] {
    // Cherche par chemin exact en premier
    const exact = this.index.get(targetPath)
    if (exact) return [...exact.values()]

    // Cherche par nom de fichier sans extension (ex. "s1" pour "s1.md")
    const basename = targetPath.split('/').at(-1) ?? targetPath
    const stem = basename.includes('.') ? basename.slice(0, basename.lastIndexOf('.')) : basename

    const results = new Map<string, BacklinkEntry>()
    for (const [target, inner] of this.index) {
      const tBasename = target.split('/').at(-1) ?? target
      const tStem = tBasename.includes('.') ? tBasename.slice(0, tBasename.lastIndexOf('.')) : tBasename
      if (tStem === stem || target === stem) {
        for (const [id, entry] of inner) results.set(id, entry)
      }
    }
    return [...results.values()]
  }
}
