// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { IndexContributor, SharedIndexEntry } from '@savoire/plugin-api'
import type { DocMetadata, CrdtVersion } from '@savoire/domain-index'

// Extrait le frontmatter et le premier H1 du markdown stabilise.
// Produit les metadonnees de niveau 2 (titre, tags, alias, frontmatter brut).
//
// crdtVersion est LOCALE et n'est pas partagee : elle decrit l'etat du
// document chez CE pair (voir updateCrdtVersion, appele par IndexEngine apres
// onTextChange). La partager n'aurait aucun sens entre pairs.
export class MetadataIndexContributor implements IndexContributor {
  readonly namespace = 'metadata'

  private readonly store = new Map<string, DocMetadata>()
  private readonly localVersions = new Map<string, CrdtVersion>()

  computeEntries(docId: string, path: string, markdown: string): SharedIndexEntry[] {
    const frontmatter = parseFrontmatter(markdown)
    return [{
      key: 'meta',
      value: {
        docId,
        path,
        crdtVersion: { clock: 0 },
        title: resolveTitle(frontmatter, markdown),
        tags: resolveTags(frontmatter, markdown),
        aliases: resolveAliases(frontmatter),
        frontmatter,
      } satisfies DocMetadata,
    }]
  }

  onEntriesChanged(byDoc: ReadonlyMap<string, SharedIndexEntry[]>): void {
    this.store.clear()
    for (const [docId, entries] of byDoc) {
      const entry = entries.find(e => e.key === 'meta')
      if (!entry) continue
      const meta = { ...(entry.value as DocMetadata) }
      const localVersion = this.localVersions.get(docId)
      if (localVersion) meta.crdtVersion = localVersion
      this.store.set(docId, meta)
    }
  }

  getMetadata(docId: string): DocMetadata | null {
    return this.store.get(docId) ?? null
  }

  getAllMetadata(): DocMetadata[] {
    return [...this.store.values()]
  }

  /** Appele par IndexEngine apres onTextChange. Purement local. */
  updateCrdtVersion(docId: string, version: CrdtVersion): void {
    this.localVersions.set(docId, version)
    const entry = this.store.get(docId)
    if (entry) entry.crdtVersion = version
  }
}

// ── Minimal frontmatter parser ─────────────────────────────────────────────────
// Handles the most common YAML patterns without a full parser dependency.

function parseFrontmatter(markdown: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)
  if (!match) return {}
  const result: Record<string, unknown> = {}
  const lines = match[1].split(/\r?\n/)
  let currentKey: string | null = null
  let currentArray: string[] = []

  for (const line of lines) {
    if (currentKey && /^\s{2,}-\s+/.test(line)) {
      currentArray.push(line.replace(/^\s{2,}-\s+/, '').trim())
      continue
    }
    if (currentKey && currentArray.length > 0) {
      result[currentKey] = currentArray
      currentKey = null
      currentArray = []
    }
    const kv = /^([\w-]+):\s*(.*)$/.exec(line)
    if (!kv) continue
    const [, key, value] = kv
    if (!value || value === '[]') {
      currentKey = key
    } else if (value.startsWith('[') && value.endsWith(']')) {
      result[key] = value.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean)
    } else {
      result[key] = value
    }
  }
  if (currentKey && currentArray.length > 0) result[currentKey] = currentArray
  return result
}

function resolveTitle(frontmatter: Record<string, unknown>, markdown: string): string {
  if (typeof frontmatter['title'] === 'string') return frontmatter['title']
  const h1 = /^#\s+(.+)$/m.exec(markdown)
  return h1 ? h1[1].trim() : ''
}

function resolveTags(frontmatter: Record<string, unknown>, markdown: string): string[] {
  const fm = frontmatter['tags']
  const fmTags = Array.isArray(fm)
    ? fm.map(String)
    : typeof fm === 'string' ? [fm] : []
  const inlineTags = [...markdown.matchAll(/(?<![[\w])#([\w\u00C0-\u017E]+)/g)].map(m => m[1])
  return [...new Set([...fmTags, ...inlineTags])]
}

function resolveAliases(frontmatter: Record<string, unknown>): string[] {
  const a = frontmatter['aliases']
  if (Array.isArray(a)) return a.map(String)
  if (typeof a === 'string') return [a]
  return []
}
