// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Sous-pages, convention « note de dossier » : la page `Projet.page` range
// ses sous-pages dans le dossier frere `Projet/`. Un lien vers une sous-page
// est son chemin dans le vault sans extension, comme un [[lien wiki]] :
// `Projet/Nom`.

export const PAGE_EXTENSION = 'page'

/** Chemin sans l'extension .page : `A/Projet.page` -> `A/Projet`. */
export function pageStem(path: string): string {
  return path.replace(/\.page$/i, '')
}

/** Dossier des sous-pages d'une page : `A/Projet.page` -> `A/Projet/`. */
export function subPageFolder(path: string): string {
  return pageStem(path) + '/'
}

/** Nom de fichier propre : sans separateur ni caractere interdit. */
export function cleanPageName(name: string): string {
  return name.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '')
}

/**
 * Chemin d'une nouvelle sous-page, sans collision avec `existing`
 * (chemins complets) : `Nom`, puis `Nom 2`, `Nom 3`... `extension` : un
 * autre type de document range sous la page (dessin, note Markdown...).
 */
export function subPagePath(pagePath: string, name: string, existing: ReadonlySet<string>, extension = PAGE_EXTENSION): string {
  const folder = subPageFolder(pagePath)
  const base = cleanPageName(name) || 'Sans titre'
  let candidate = `${folder}${base}.${extension}`
  for (let n = 2; existing.has(candidate); n++) candidate = `${folder}${base} ${n}.${extension}`
  return candidate
}

/**
 * Cible d'un lien vers un document : son chemin, sans extension pour une
 * page (`Projet/Nom`), avec pour les autres types (`Projet/Plan.excalidraw`).
 */
export function linkTargetOf(path: string): string {
  return pageStem(path)
}

/**
 * Fichier vise par un lien. Une cible sans extension designe une page ;
 * a defaut, une note Markdown du meme nom si elle existe.
 */
export function resolveLinkTarget(target: string, exists: (path: string) => boolean): string {
  if (/\.[a-z0-9]+$/i.test(target.split('/').at(-1) ?? '')) return target
  const page = `${target}.${PAGE_EXTENSION}`
  if (exists(page)) return page
  if (exists(`${target}.md`)) return `${target}.md`
  return page
}
