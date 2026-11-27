// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Favoris (comme les « Signets » d'Obsidian) : des notes, des passages
// (titre ou bloc d'une note), des dossiers, des adresses web. Une liste par
// personne et par vault, gardee sur ce poste.
//
// Une note est retenue par son id de document : la renommer ou la deplacer ne
// perd pas le favori. Le chemin garde sert a l'afficher si le document n'est
// plus la (supprime, ou pas encore arrive).

export type Bookmark =
  | { type: 'file'; docId?: string; path: string; subpath?: string; title?: string }
  | { type: 'folder'; path: string; title?: string }
  | { type: 'url'; url: string; title?: string }

const KEY = 'savoire-bookmarks:'

/** Le meme favori (meme note et meme passage, meme dossier, meme adresse) ? */
export function sameBookmark(a: Bookmark, b: Bookmark): boolean {
  if (a.type !== b.type) return false
  if (a.type === 'file' && b.type === 'file') {
    const same = a.docId && b.docId ? a.docId === b.docId : a.path === b.path
    return same && (a.subpath ?? '') === (b.subpath ?? '')
  }
  if (a.type === 'folder' && b.type === 'folder') return a.path === b.path
  return a.type === 'url' && b.type === 'url' && a.url === b.url
}

/** Ajoute le favori s'il n'y est pas, l'enleve sinon. Rend la nouvelle liste et s'il y est. */
export function toggleBookmark(list: readonly Bookmark[], b: Bookmark): { list: Bookmark[]; added: boolean } {
  return list.some(x => sameBookmark(x, b))
    ? { list: list.filter(x => !sameBookmark(x, b)), added: false }
    : { list: [...list, b], added: true }
}

/** Deplace un favori d'une place vers le haut (-1) ou le bas (1). */
export function moveBookmark(list: readonly Bookmark[], index: number, dir: 1 | -1): Bookmark[] {
  const to = index + dir
  if (index < 0 || to < 0 || index >= list.length || to >= list.length) return [...list]
  const out = [...list]
  ;[out[index], out[to]] = [out[to], out[index]]
  return out
}

function valid(b: unknown): b is Bookmark {
  const x = b as Partial<Record<string, unknown>> | null
  if (!x || typeof x !== 'object') return false
  if (x.type === 'file' || x.type === 'folder') return typeof x.path === 'string' && !!x.path
  return x.type === 'url' && typeof x.url === 'string' && /^https?:\/\//i.test(x.url)
}

export class BookmarkStore {
  private list: Bookmark[] = []
  private key: string | null = null
  private readonly listeners = new Set<() => void>()

  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = typeof localStorage === 'undefined' ? null : localStorage) {}

  /** La liste de cette personne dans ce vault (null : aucun vault ouvert). */
  attach(vaultId: string | null, userId: string | null): void {
    const key = vaultId ? `${KEY}${vaultId}:${userId ?? 'local'}` : null
    if (key === this.key) return
    this.key = key
    this.list = []
    if (key && this.storage) {
      try {
        const raw = JSON.parse(this.storage.getItem(key) ?? '[]') as unknown
        this.list = Array.isArray(raw) ? raw.filter(valid) : []
      } catch { this.list = [] }
    }
    this.emit()
  }

  all(): readonly Bookmark[] {
    return this.list
  }

  has(b: Bookmark): boolean {
    return this.list.some(x => sameBookmark(x, b))
  }

  set(list: Bookmark[]): void {
    this.list = list
    if (this.key && this.storage) {
      try { this.storage.setItem(this.key, JSON.stringify(list)) } catch { /* stockage plein ou interdit */ }
    }
    this.emit()
  }

  toggle(b: Bookmark): boolean {
    const r = toggleBookmark(this.list, b)
    this.set(r.list)
    return r.added
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  private emit(): void {
    for (const cb of this.listeners) cb()
  }
}
