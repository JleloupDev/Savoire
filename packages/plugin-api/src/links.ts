// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Liens entre fichiers du vault, comme Obsidian : un lien vise une note par
// son nom (`[[Genèse 2]]`, `![[Genèse 2#^16]]`), quel que soit son dossier.
// Si plusieurs fichiers portent ce nom, le lien porte le chemin
// (`[[Bible/Genèse 2]]`) ; a la lecture, un nom ambigu va au chemin le plus
// court. L'extension .md des notes est facultative.
//
// Memes regles que l'index du vault (indexer-core, powers/links.ts) :
// casse ignoree, chemin exact, puis nom, puis fin de chemin ; a egalite, la
// note (.md) avant les autres fichiers, puis le chemin le plus court.
// Une seule fonction pour tous : editeur, integrations, retroliens, graphe.

const NOTE_EXT = '.md'

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/**
 * Extension d'un nom de fichier, sans le point, ou '' s'il n'en a pas.
 * Un point dans un nom de note n'est pas une extension : « Ps. 23 »,
 * « Note v1.2 », « il a gagne. Mais » n'en ont pas. Une extension est faite
 * de lettres (et de chiffres apres la premiere), sans espace : png, md, mp4.
 */
export function fileExtensionOf(path: string): string {
  const name = nameOf(path)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return ''
  const ext = name.slice(dot + 1)
  return /^[A-Za-z][A-Za-z0-9]{0,9}$/.test(ext) ? ext.toLowerCase() : ''
}

/** Chemin d'une note : `.md` ajoute si le nom n'a pas d'extension. */
export function withNoteExtension(path: string): string {
  return fileExtensionOf(path) ? path : `${path}${NOTE_EXT}`
}

/** Nom affiche d'un fichier : sans `.md` pour une note, tel quel sinon. */
export function noteName(path: string): string {
  const name = nameOf(path)
  return name.toLowerCase().endsWith(NOTE_EXT) ? name.slice(0, -NOTE_EXT.length) : name
}

/** Ce qu'un lien peut viser dans ce fichier, en minuscules : chemin et chemin sans .md. */
function keysOf(path: string): { full: string; bare: string; name: string; stem: string } {
  const full = path.toLowerCase()
  const bare = full.endsWith(NOTE_EXT) ? full.slice(0, -NOTE_EXT.length) : full
  return { full, bare, name: nameOf(full), stem: nameOf(bare) }
}

function best(candidates: string[]): string | undefined {
  return candidates.sort((a, b) => {
    const am = a.toLowerCase().endsWith(NOTE_EXT) ? 0 : 1
    const bm = b.toLowerCase().endsWith(NOTE_EXT) ? 0 : 1
    return am - bm || a.length - b.length || a.localeCompare(b)
  })[0]
}

function cleanTarget(target: string): string {
  return target.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '')
}

/** Resolution de nombreux liens contre les memes fichiers : index fait une fois. */
export interface LinkResolver {
  resolve(target: string): string | undefined
}

/** Prepare la resolution des liens parmi `paths` (retroliens, graphe...). */
export function createLinkResolver(paths: readonly string[]): LinkResolver {
  const exactSet = new Set(paths)
  const byPath = new Map<string, string[]>()   // chemin complet ou sans .md
  const byName = new Map<string, string[]>()   // nom ou nom sans .md
  const push = (map: Map<string, string[]>, key: string, p: string) => {
    const list = map.get(key)
    if (!list) map.set(key, [p])
    else if (!list.includes(p)) list.push(p)
  }
  for (const p of paths) {
    const k = keysOf(p)
    push(byPath, k.full, p); push(byPath, k.bare, p)
    push(byName, k.name, p); push(byName, k.stem, p)
  }
  return {
    resolve(target: string): string | undefined {
      const t = cleanTarget(target)
      if (!t) return undefined
      if (exactSet.has(t)) return t
      const k = t.toLowerCase()
      const exact = byPath.get(k)
      if (exact) return best([...exact])
      if (!k.includes('/')) {
        const named = byName.get(k)
        return named ? best([...named]) : undefined
      }
      // Fin de chemin (« dossier/note ») : parmi les fichiers de ce nom.
      const named = byName.get(k.slice(k.lastIndexOf('/') + 1)) ?? []
      return best(named.filter(p => {
        const o = keysOf(p)
        return o.full.endsWith(`/${k}`) || o.bare.endsWith(`/${k}`)
      }))
    },
  }
}

/**
 * Fichier vise par un lien (`cible` sans `#section` ni `|alias`), parmi
 * `paths`. undefined : aucun. Pour beaucoup de liens : createLinkResolver.
 */
export function resolveLinkPath(target: string, paths: readonly string[]): string | undefined {
  return createLinkResolver(paths).resolve(target)
}

/**
 * Texte a mettre dans un lien vers `path` : le nom seul s'il est unique dans
 * le vault (`paths`), sinon le chemin. Sans `.md` pour une note.
 */
export function linkTargetFor(path: string, paths: readonly string[]): string {
  const isNote = path.toLowerCase().endsWith(NOTE_EXT)
  const shown = isNote ? path.slice(0, -NOTE_EXT.length) : path
  // Fichier hors de la liste (corbeille...) : le chemin, un nom n'y menerait pas.
  if (!paths.includes(path)) return shown
  const own = keysOf(path)
  const key = isNote ? own.stem : own.name
  const sameName = paths.filter(p => {
    if (p === path) return false
    const o = keysOf(p)
    return o.name === key || o.stem === key
  })
  return sameName.length === 0 ? nameOf(shown) : shown
}
