// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
/**
 * Notes de dossier : logique pure, sans rendu.
 *
 * Un fichier `Projet.page` et un dossier frere `Projet/` (meme parent, meme
 * nom sans extension) forment un seul noeud de l'arborescence. Rien de special
 * n'est ecrit sur disque : le fichier reste un fichier, le dossier un dossier.
 *
 * Si plusieurs fichiers freres correspondent au dossier, un seul devient la
 * note de dossier : d'abord `.page`, puis `.md`, puis le premier par ordre
 * alphabetique du nom complet. Les autres restent des fichiers ordinaires.
 *
 * Conventions de chemin (celles de VaultAPI.list) : un dossier finit par `/`,
 * un fichier non.
 */

export type TreeNode =
  | { kind: 'file'; name: string; path: string }
  | { kind: 'folder'; name: string; path: string }
  | {
      kind: 'folderNote'
      /** Nom affiche : celui du dossier (le fichier sans extension). */
      name: string
      /** Chemin du fichier : c'est lui qu'on ouvre. */
      path: string
      /** Nom complet du fichier, extension comprise. */
      fileName: string
      /** Chemin du dossier, avec `/` final. */
      folderPath: string
    }

export type TreeNodeWithChildren = TreeNode & { children?: TreeNodeWithChildren[] }

/** Ordre de preference des extensions pour la note de dossier. */
const NOTE_PRIORITY = ['page', 'md']

/** Dernier segment d'un chemin, sans le `/` final d'un dossier. */
export function lastSegment(path: string): string {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

/** Dossier parent avec `/` final, ou `''` a la racine. */
export function parentOf(path: string): string {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  const idx = trimmed.lastIndexOf('/')
  return idx === -1 ? '' : trimmed.slice(0, idx + 1)
}

/** Extension d'un nom de fichier (sans le point), ou `''`. */
export function extensionOf(fileName: string): string {
  const name = lastSegment(fileName)
  const idx = name.lastIndexOf('.')
  return idx <= 0 ? '' : name.slice(idx + 1)
}

/** Nom de fichier sans sa derniere extension. `''` si le fichier n'en a pas. */
export function stemOf(fileName: string): string {
  const name = lastSegment(fileName)
  const idx = name.lastIndexOf('.')
  return idx <= 0 ? '' : name.slice(0, idx)
}

/** Dossier associe a un fichier : `A/Projet.page` -> `A/Projet/`. */
export function folderOfNote(filePath: string): string {
  const stem = stemOf(filePath)
  return stem ? parentOf(filePath) + stem + '/' : ''
}

function notePriority(fileName: string): number {
  const idx = NOTE_PRIORITY.indexOf(extensionOf(fileName))
  return idx === -1 ? NOTE_PRIORITY.length : idx
}

/**
 * Regroupe les entrees d'UN niveau (sortie de VaultAPI.list) en noeuds.
 * L'ordre d'entree est garde ; une note de dossier prend la place du premier
 * de ses deux elements.
 */
export function groupEntries(entries: readonly string[]): TreeNode[] {
  const folders = new Set(entries.filter(e => e.endsWith('/')))
  // Pour chaque dossier, le fichier elu comme note.
  const noteOf = new Map<string, string>()
  for (const entry of entries) {
    if (entry.endsWith('/')) continue
    const folder = folderOfNote(entry)
    if (!folder || !folders.has(folder)) continue
    const current = noteOf.get(folder)
    if (current === undefined || isBetterNote(entry, current)) noteOf.set(folder, entry)
  }
  const merged = new Set<string>()
  for (const [folder, file] of noteOf) { merged.add(folder); merged.add(file) }

  const nodes: TreeNode[] = []
  const emitted = new Set<string>()
  for (const entry of entries) {
    if (merged.has(entry)) {
      const folderPath = entry.endsWith('/') ? entry : folderOfNote(entry)
      if (emitted.has(folderPath)) continue
      emitted.add(folderPath)
      const file = noteOf.get(folderPath)!
      nodes.push({
        kind: 'folderNote',
        name: lastSegment(folderPath),
        path: file,
        fileName: lastSegment(file),
        folderPath,
      })
    } else if (entry.endsWith('/')) {
      nodes.push({ kind: 'folder', name: lastSegment(entry), path: entry })
    } else {
      nodes.push({ kind: 'file', name: lastSegment(entry), path: entry })
    }
  }
  return nodes
}

function isBetterNote(candidate: string, current: string): boolean {
  const a = notePriority(candidate)
  const b = notePriority(current)
  if (a !== b) return a < b
  return lastSegment(candidate) < lastSegment(current)
}

/** Entrees directes d'un dossier, calculees comme VaultAPI.list. */
export function listLevel(paths: readonly string[], dir: string): string[] {
  const prefix = dir === '' || dir.endsWith('/') ? dir : dir + '/'
  const result = new Set<string>()
  for (const p of paths) {
    if (!p.startsWith(prefix)) continue
    const rest = p.slice(prefix.length)
    if (!rest) continue
    const slash = rest.indexOf('/')
    result.add(slash === -1 ? prefix + rest : prefix + rest.slice(0, slash + 1))
  }
  return Array.from(result).sort()
}

/**
 * Liste plate de chemins (fichiers, et dossiers avec `/` final) -> arbre
 * complet avec notes de dossier. Les enfants d'une note de dossier sont ceux
 * de son dossier.
 */
export function buildPathTree(paths: readonly string[], dir = ''): TreeNodeWithChildren[] {
  return groupEntries(listLevel(paths, dir)).map(node => {
    if (node.kind === 'file') return node
    const folder = node.kind === 'folder' ? node.path : node.folderPath
    return { ...node, children: buildPathTree(paths, folder) }
  })
}

/** Vrai si `path` est dans `folderPath` (a n'importe quelle profondeur). */
export function isInside(path: string, folderPath: string): boolean {
  return path !== folderPath && path.startsWith(folderPath)
}

/** Remplace le prefixe `from` par `to` (deux dossiers avec `/` final). */
export function rebasePath(path: string, from: string, to: string): string {
  return path.startsWith(from) ? to + path.slice(from.length) : path
}

/**
 * Chemin libre pour une nouvelle sous-page : `Dossier/Sans titre.ext`, puis
 * `Sans titre 2.ext`, etc.
 */
export function uniqueChildPath(
  folderPath: string,
  extension: string,
  existing: ReadonlySet<string>,
  base = 'Sans titre',
): string {
  const suffix = extension ? '.' + extension : ''
  let candidate = folderPath + base + suffix
  for (let n = 2; existing.has(candidate); n++) candidate = `${folderPath}${base} ${n}${suffix}`
  return candidate
}
