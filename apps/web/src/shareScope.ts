// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Ce qu'ouvre un lien vers une page, calcule dans l'appli (le serveur ne lit
// pas les notes) : ses sous-pages (le dossier de la page, images comprises)
// ou ses pages liees, de proche en proche.
import { createLinkResolver, linkedPathsOf } from '@savoire/plugin-api'

export interface PageRef { id: string; path: string }

/** Au plus tant de pages liees (comme le serveur). */
export const MAX_LINKED_PAGES = 2000

/** Fichiers sans liens a lire (images, PDF, bureautique, medias). */
const OPAQUE = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg|pdf|docx?|xlsx?|pptx?|odt|ods|odp|zip|mp3|mp4|m4a|wav|ogg|webm|mov)$/i

function stemOf(path: string): string {
  const slash = path.lastIndexOf('/')
  const dot = path.lastIndexOf('.')
  return dot > slash + 1 ? path.slice(0, dot) : path
}

/** Les sous-pages d'une page : tout ce qui est rangé dans son dossier (« A/Projet/ » pour « A/Projet.md »). */
export function subpagesOf(page: PageRef, docs: readonly PageRef[]): PageRef[] {
  const prefix = `${stemOf(page.path)}/`
  return docs
    .filter(d => d.id !== page.id && d.path.startsWith(prefix))
    .map(d => ({ id: d.id, path: d.path }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * Les pages liees a `start`, de proche en proche : celles qu'elle lie, celles
 * que celles-ci lient, etc. `read` : le texte d'un document. Sans `start`.
 */
export async function linkedPages(
  start: PageRef,
  docs: readonly PageRef[],
  read: (id: string) => Promise<string>,
  limit = MAX_LINKED_PAGES,
): Promise<PageRef[]> {
  const resolver = createLinkResolver(docs.map(d => d.path))
  const byPath = new Map(docs.map(d => [d.path, d]))
  const seen = new Set([start.path])
  const out: PageRef[] = []
  const queue: PageRef[] = [start]
  while (queue.length > 0 && out.length < limit) {
    const current = queue.shift()!
    if (OPAQUE.test(current.path)) continue
    const text = await read(current.id).catch(() => '')
    for (const path of linkedPathsOf(text, current.path, resolver)) {
      if (seen.has(path)) continue
      seen.add(path)
      const doc = byPath.get(path)
      if (!doc) continue
      out.push({ id: doc.id, path: doc.path })
      if (out.length >= limit) break
      queue.push(doc)
    }
  }
  return out
}

/** Les pages qu'ouvrirait un lien vers `page`, selon sa portee (dialogue de partage). */
export interface SharePages {
  subpages(): PageRef[]
  linked(): Promise<PageRef[]>
}

export function sharePagesOf(client: { readonly documents: readonly PageRef[]; read(id: string): Promise<string> }, page: PageRef): SharePages {
  return {
    subpages: () => subpagesOf(page, client.documents),
    linked: () => linkedPages(page, client.documents, id => client.read(id)),
  }
}
