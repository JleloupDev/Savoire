// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { IndexContributor } from '@savoire/plugin-api'

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

  // Map<targetPath, Map<sourceDocId, BacklinkEntry>>
  // see ADR-017
  private readonly index = new Map<string, Map<string, BacklinkEntry>>()

  private _processedSeq = -1

  get processedSeq(): number { return this._processedSeq }

  restore(snapshot: string, processedSeq: number): void {
    try {
      const data = JSON.parse(snapshot) as Record<string, BacklinkEntry[]>
      this.index.clear()
      for (const [target, entries] of Object.entries(data)) {
        const inner = new Map<string, BacklinkEntry>()
        for (const e of entries) inner.set(e.docId, e)
        this.index.set(target, inner)
      }
      this._processedSeq = processedSeq
    } catch (err) {
      console.warn('[BacklinksIndexContributor] restore failed:', err)
    }
  }

  onOp(seq: number | null, docId: string, path: string, markdownContent: string): void {
    // 1. Retire toutes les entrées existantes de ce document source
    for (const inner of this.index.values()) {
      inner.delete(docId)
    }

    // 2. Réindexe les wikilinks présents dans le contenu courant
    const targets = extractWikilinks(markdownContent)
    for (const target of targets) {
      let inner = this.index.get(target)
      if (!inner) { inner = new Map(); this.index.set(target, inner) }
      inner.set(docId, { docId, path })
    }

    // 3. Nettoie les cibles vides
    for (const [target, inner] of this.index) {
      if (inner.size === 0) this.index.delete(target)
    }

    if (seq !== null) this._processedSeq = seq
  }

  snapshot(): string {
    const data: Record<string, BacklinkEntry[]> = {}
    for (const [target, inner] of this.index) {
      data[target] = [...inner.values()]
    }
    return JSON.stringify(data)
  }

  /**
   * Retourne les documents qui contiennent un lien vers `targetPath`.
   * Recherche par chemin exact ou par nom de fichier sans extension.
   */
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
