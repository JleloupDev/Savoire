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

// ── Liens qui suivent un deplacement ──────────────────────────────────────
//
// Un fichier (image, note) change de chemin : les liens qui le visaient sont
// recrits pour le viser encore, comme Obsidian. Un lien par nom qui le
// trouve toujours reste tel quel ; sinon il prend le nom (s'il est unique)
// ou le nouveau chemin. Les liens [[...]], ![[...]] et Markdown [..](..)
// sont suivis ; le code (blocs ``` et `...`) n'est jamais touche.

function folderOfPath(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '' : path.slice(0, slash)
}

/** `a/b` + `../c/d.png` -> `a/c/d.png`. */
function joinRelative(folder: string, rel: string): string {
  const parts = folder ? folder.split('/') : []
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return parts.join('/')
}

/** Chemin de `to` vu depuis le dossier `fromFolder` (« ../Images/x.png »). */
function relativeTo(fromFolder: string, to: string): string {
  const a = fromFolder ? fromFolder.split('/') : []
  const b = to.split('/')
  let i = 0
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/')
}

const WIKI_LINK_RE = /(!?)\[\[([^[\]|#\n]*)(#[^[\]|\n]*)?(\|[^[\]\n]*)?\]\]/g
const MD_LINK_RE = /(!?\[[^\]\n]*\]\()(<[^>\n]+>|[^)\s]+)(\))/g
const FENCE_LINE_RE = /^ {0,3}(`{3,}|~{3,})/

export interface LinkMoveContext {
  /** Ancien chemin -> nouveau chemin, pour chaque fichier deplace. */
  moves: ReadonlyMap<string, string>
  /** Les fichiers du vault AVANT le deplacement (pour resoudre les liens tels qu'ecrits). */
  before: LinkResolver
  /** Les fichiers APRES : un lien qui trouve encore sa cible reste tel quel. */
  after?: LinkResolver
  /** Texte d'un lien [[...]] vers ce nouveau chemin (nom si unique, sinon chemin). */
  targetFor(newPath: string): string
}

/**
 * Le texte d'une note dont les liens suivent les deplacements, ou null si
 * rien ne change. `oldSource` / `newSource` : chemin de la note avant et
 * apres (elle a pu bouger aussi), pour les liens Markdown relatifs.
 */
export function rewriteMovedLinks(text: string, ctx: LinkMoveContext, oldSource: string, newSource = oldSource): string | null {
  let changed = false
  let fence: string | null = null
  const out = text.split('\n').map(line => {
    const f = line.match(FENCE_LINE_RE)
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null
      return line
    }
    if (f) { fence = f[1]; return line }
    // Le code en ligne garde son texte : on travaille entre les `...`.
    const next = line.split(/(`[^`]*`)/).map(part => part.startsWith('`') && part.endsWith('`') && part.length > 1 ? part : rewritePart(part)).join('')
    if (next !== line) changed = true
    return next
  })
  return changed ? out.join('\n') : null

  function rewritePart(part: string): string {
    return part
      .replace(WIKI_LINK_RE, (whole, bang: string, target: string, sub: string | undefined, alias: string | undefined) => {
        const t = target.trim()
        if (!t) return whole
        const resolved = ctx.before.resolve(t)
        const moved = resolved !== undefined ? ctx.moves.get(resolved) : undefined
        if (moved === undefined) return whole
        if (ctx.after?.resolve(t) === moved) return whole
        let next = ctx.targetFor(moved)
        if (/\.md$/i.test(t) && !/\.md$/i.test(next)) next = `${next}.md`
        if (next === t) return whole
        return `${bang}[[${next}${sub ?? ''}${alias ?? ''}]]`
      })
      .replace(MD_LINK_RE, (whole, head: string, rawUrl: string, tail: string) => {
        const angled = rawUrl.startsWith('<')
        const url = angled ? rawUrl.slice(1, -1) : rawUrl
        if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('#')) return whole
        const hash = url.indexOf('#')
        const pathPart = hash < 0 ? url : url.slice(0, hash)
        const anchor = hash < 0 ? '' : url.slice(hash)
        let decoded = pathPart
        try { decoded = decodeURI(pathPart) } catch { /* tel quel */ }
        const fromRoot = decoded.startsWith('/')
        const candidate = fromRoot ? decoded.replace(/^\/+/, '') : joinRelative(folderOfPath(oldSource), decoded)
        const resolved = ctx.before.resolve(candidate) ?? ctx.before.resolve(decoded)
        const moved = resolved !== undefined ? ctx.moves.get(resolved) : undefined
        if (moved === undefined) return whole
        const nextPath = fromRoot ? `/${moved}` : relativeTo(folderOfPath(newSource), moved)
        const encoded = angled ? nextPath : encodeURI(nextPath)
        const nextUrl = `${encoded}${anchor}`
        if (nextUrl === url) return whole
        return `${head}${angled ? `<${nextUrl}>` : nextUrl}${tail}`
      })
  }
}
