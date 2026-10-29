// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Chemins du vault : relatifs a sa racine, separes par '/', sans '/' de tete.
// folderOf et extOf suivent le moteur de reference (InMemoryQueryEngine).

export const TRASH_PREFIX = '.trash/'

/** Types de documents dont le noyau sait lire le contenu. */
export const NOTE_EXTENSIONS: ReadonlySet<string> = new Set(['md', 'outline', 'page', 'excalidraw', 'mindmap'])

/** Pieces jointes : un lien vers elles n'est pas un lien entre notes. */
export const ATTACHMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'avif', 'ico', 'tif', 'tiff', 'heic',
  'pdf', 'mp3', 'wav', 'ogg', 'm4a', 'flac', 'mp4', 'webm', 'mov', 'mkv', 'avi',
  'zip', 'gz', 'tar', '7z', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'csv',
])

export function isTrashPath(path: string): boolean {
  return path.startsWith(TRASH_PREFIX)
}

/** Dossier d'un chemin ('' a la racine). */
export function folderOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

/** Nom de fichier (dernier segment). */
export function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** Extension en minuscules, sans le point ('' sans extension ou fichier cache). */
export function extOf(path: string): string {
  const name = nameOf(path)
  const i = name.lastIndexOf('.')
  return i <= 0 ? '' : name.slice(i + 1).toLowerCase()
}

/** Nom sans extension. */
export function stemOf(path: string): string {
  const name = nameOf(path)
  const i = name.lastIndexOf('.')
  return i <= 0 ? name : name.slice(0, i)
}

/** Chemin sans son extension. */
export function withoutExt(path: string): string {
  const ext = extOf(path)
  return ext ? path.slice(0, path.length - ext.length - 1) : path
}

/**
 * Resout `.` et `..`, retire les '/' en trop. Rend null si le chemin sort de
 * la racine du vault.
 */
export function normalizePath(path: string): string | null {
  const out: string[] = []
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length === 0) return null
      out.pop()
      continue
    }
    out.push(seg)
  }
  return out.join('/')
}

/** Chemin `rel` vu depuis le dossier `folder`. */
export function resolveFrom(folder: string, rel: string): string | null {
  return normalizePath(folder ? `${folder}/${rel}` : rel)
}

/** Prefixe d'un dossier pour un filtre (« Notes » -> « Notes/ »), comme le moteur de reference. */
export function folderPrefix(folder: string | undefined): string {
  return folder ? folder.replace(/\/+$/, '') + '/' : ''
}

/** Extensions d'un filtre, comme le moteur de reference. */
export function normalizeExts(ext: readonly string[] | undefined): string[] | undefined {
  return ext?.map(e => e.toLowerCase().replace(/^\./, ''))
}

/** Cles de resolution des liens d'un document (casse ignoree). */
export function docKeys(path: string): { nameKey: string; nameFullKey: string; pathKey: string; fullKey: string } {
  const full = path.toLowerCase()
  const name = nameOf(full)
  const stem = stemOf(full)
  return { nameKey: stem, nameFullKey: name, pathKey: full.slice(0, full.length - name.length) + stem, fullKey: full }
}
