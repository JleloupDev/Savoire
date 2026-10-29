// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Lecture d'un corps Markdown (sans son frontmatter) pour l'index : texte
// brut par section, premier titre, liens, tags. Fonctions pures.
//
// Ce n'est pas un rendu Markdown complet : on garde ce que l'index cherche
// (les mots, les titres, les liens entre notes, les tags), on jette la
// syntaxe. Regles suivies, celles d'Obsidian quand elles existent :
//  - le code (blocs ``` / ~~~ et `code` en ligne) reste dans le texte, mais
//    ne donne ni lien, ni tag, ni titre ;
//  - les commentaires %% ... %% et <!-- ... --> disparaissent ;
//  - un tag est `#mot` en debut de ligne ou apres un espace, avec au moins
//    une lettre ; lettres, chiffres, `_`, `-` et `/` (tags imbriques a/b) ;
//  - liens : [[cible]], [[cible|alias]], [[cible#titre]], ![[incrustation]],
//    et [texte](chemin) vers une note (pas d'adresse externe ni de piece
//    jointe).
import { ATTACHMENT_EXTENSIONS, NOTE_EXTENSIONS, extOf } from '../paths'

export interface Section {
  /** Titre de la section ; absent pour le texte d'avant le premier titre. */
  heading?: string
  /** Niveau du titre (1 a 6). */
  level?: number
  /** Texte brut de la section, titre compris (premiere ligne), une ligne par bloc. */
  text: string
}

export interface LinkRef {
  /** Cible telle qu'ecrite, sans #section ni |alias ; decodee pour un lien Markdown. */
  target: string
  /** Partie apres '#' : titre ou ^bloc. */
  subpath?: string
  /** Texte affiche choisi par l'auteur. */
  alias?: string
  /** ![[...]] ou ![...](...) : incrustation. */
  embed: boolean
  kind: 'wiki' | 'markdown'
}

export interface MarkdownParts {
  /** Texte du premier titre de niveau 1, s'il y en a un. */
  h1?: string
  sections: Section[]
  links: LinkRef[]
  /** Tags du texte, sans '#', dans l'ordre, sans doublon (casse ignoree). */
  tags: string[]
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/
const WIKILINK = /(!?)\[\[([^[\]\n]+?)\]\]/g
const MDLINK = /(!?)\[((?:[^[\]\n]|\[[^[\]\n]*\])*)\]\(\s*(<[^>\n]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*\)/g
const TAG = /(?<!\S)#([\p{L}\p{N}\p{M}_\-/]+)/gu
const SCHEME = /^[a-z][a-z0-9+.-]*:/i
const BLOCK_ID = /\s\^[A-Za-z0-9-]+\s*$/

interface Segment { text: string; code: boolean }

/** Decoupe une ligne en morceaux de texte et de code en ligne (`...`). */
function splitCode(s: string): Segment[] {
  const out: Segment[] = []
  let i = 0
  let last = 0
  while (i < s.length) {
    if (s[i] !== '`') { i++; continue }
    let j = i
    while (j < s.length && s[j] === '`') j++
    const n = j - i
    // Fermeture : une suite d'exactement n accents graves.
    let k = j
    let close = -1
    while (k < s.length) {
      if (s[k] !== '`') { k++; continue }
      let m = k
      while (m < s.length && s[m] === '`') m++
      if (m - k === n) { close = k; break }
      k = m
    }
    if (close < 0) { i = j; continue }
    if (i > last) out.push({ text: s.slice(last, i), code: false })
    out.push({ text: s.slice(j, close), code: true })
    i = last = close + n
  }
  if (last < s.length) out.push({ text: s.slice(last), code: false })
  return out
}

function blank(s: string): string {
  return ' '.repeat(s.length)
}

function decode(s: string): string {
  try { return decodeURIComponent(s) } catch { return s }
}

function wikiLink(bang: string, inner: string): { link: LinkRef | null; display: string } {
  const body = inner.replace(/\\\|/g, '|')
  const bar = body.indexOf('|')
  const linkPart = bar < 0 ? body : body.slice(0, bar)
  const alias = bar < 0 ? undefined : body.slice(bar + 1).trim() || undefined
  const hash = linkPart.indexOf('#')
  const target = (hash < 0 ? linkPart : linkPart.slice(0, hash)).trim()
  const subpath = hash < 0 ? undefined : linkPart.slice(hash + 1).trim() || undefined
  const embed = bang === '!'
  const display = embed ? '' : alias ?? (target || subpath || '')
  // [[#titre]] : un lien dans la note elle-meme, pas un lien entre notes.
  if (!target || ATTACHMENT_EXTENSIONS.has(extOf(target))) return { link: null, display }
  return {
    link: { target, embed, kind: 'wiki', ...(subpath ? { subpath } : {}), ...(alias ? { alias } : {}) },
    display,
  }
}

function markdownLink(bang: string, label: string, rawUrl: string): { link: LinkRef | null; display: string } {
  const embed = bang === '!'
  const display = label
  let url = rawUrl.trim()
  if (url.startsWith('<') && url.endsWith('>')) url = url.slice(1, -1).trim()
  if (!url || url.startsWith('#') || SCHEME.test(url)) return { link: null, display }
  const hash = url.indexOf('#')
  const target = decode(hash < 0 ? url : url.slice(0, hash)).trim()
  const subpath = hash < 0 ? undefined : decode(url.slice(hash + 1)).trim() || undefined
  const ext = extOf(target)
  if (!target || (ext !== '' && !NOTE_EXTENSIONS.has(ext))) return { link: null, display }
  return {
    link: { target, embed, kind: 'markdown', ...(subpath ? { subpath } : {}), ...(label.trim() ? { alias: label.trim() } : {}) },
    display,
  }
}

/** Retire la syntaxe en ligne d'un morceau de texte (hors code). */
function stripInline(s: string): string {
  return s
    .replace(/<!--.*?-->/g, '')
    .replace(/<((?:https?|mailto|ftp):[^>\s]+)>/gi, '$1')
    .replace(/<\/?[A-Za-z][^>]*>/g, '')
    .replace(/\[\^[^\]\s]+\]/g, '')
    .replace(/(?<!\\)(\*+|~~|==)/g, '')
    .replace(/(?<![\\\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, '')
    .replace(/\\([!-/:-@[-`{-~])/g, '$1')
}

interface Inline {
  plain: string
  links: LinkRef[]
  tags: string[]
}

/** Une ligne (deja sans sa syntaxe de bloc) : texte brut, liens, tags. */
function inline(line: string): Inline {
  const links: LinkRef[] = []
  const tags: string[] = []
  let plain = ''
  for (const seg of splitCode(line.replace(BLOCK_ID, ''))) {
    if (seg.code) { plain += seg.text; continue }
    // Liens d'abord, remplaces par leur texte affiche ; un masque garde les
    // positions pour chercher les tags hors des liens.
    let masked = seg.text
    let shown = seg.text.replace(WIKILINK, (_m, bang: string, inner: string) => {
      const { link, display } = wikiLink(bang, inner)
      if (link) links.push(link)
      return display
    })
    masked = masked.replace(WIKILINK, m => blank(m))
    shown = shown.replace(MDLINK, (_m, bang: string, label: string, url: string) => {
      const { link, display } = markdownLink(bang, label, url)
      if (link) links.push(link)
      return display
    })
    masked = masked.replace(MDLINK, m => blank(m)).replace(/<!--.*?-->/g, m => blank(m))
    for (const m of masked.matchAll(TAG)) {
      const tag = m[1].replace(/^\/+|\/+$/g, '')
      if (tag && /\p{L}/u.test(tag)) tags.push(tag)
    }
    plain += stripInline(shown)
  }
  return { plain: plain.replace(/[ \t ]+/g, ' ').trim(), links, tags }
}

/** Retire les commentaires %% ... %% d'une ligne ; dit si un commentaire reste ouvert. */
function stripComments(line: string, open: boolean): { line: string; open: boolean } {
  let out = ''
  let rest = line
  let inComment = open
  for (;;) {
    const i = rest.indexOf('%%')
    if (i < 0) {
      if (!inComment) out += rest
      return { line: out, open: inComment }
    }
    if (!inComment) out += rest.slice(0, i)
    inComment = !inComment
    rest = rest.slice(i + 2)
  }
}

/** Retire la syntaxe de bloc d'une ligne. null : ligne sans texte (regle, separateur). */
function stripBlock(raw: string): { line: string; table: boolean } | null {
  let line = raw
  const quote = /^\s*(?:>\s?)+/.exec(line)
  if (quote) {
    line = line.slice(quote[0].length)
    const callout = /^\[!([^\]]+)\][+-]?\s*/.exec(line)
    if (callout) line = line.slice(callout[0].length)
  }
  if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) return null
  if (/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(line)) return null
  if (/^\s*\$\$\s*$/.test(line)) return null
  const table = /^\s*\|/.test(line)
  line = line
    .replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s+/, '')
    .replace(/^\[[^\]]\]\s+/, '')
    .replace(/^\s*\[\^[^\]]+\]:\s*/, '')
  return { line, table }
}

/** Lit un corps Markdown (sans frontmatter). */
export function parseMarkdownBody(body: string): MarkdownParts {
  const sections: Section[] = []
  const links: LinkRef[] = []
  const tagSeen = new Set<string>()
  const tags: string[] = []
  let h1: string | undefined
  let current: { heading?: string; level?: number; lines: string[] } = { lines: [] }
  let fence: { char: string; len: number } | null = null
  let comment = false

  const flush = () => {
    if (current.heading !== undefined || current.lines.length) {
      const s: Section = { text: current.lines.join('\n') }
      if (current.heading !== undefined) { s.heading = current.heading; s.level = current.level }
      sections.push(s)
    }
  }
  const addTags = (list: string[]) => {
    for (const t of list) {
      const key = t.toLowerCase()
      if (tagSeen.has(key)) continue
      tagSeen.add(key)
      tags.push(t)
    }
  }
  const pushLine = (text: string) => {
    if (text) current.lines.push(text)
  }

  for (const rawLine of body.split(/\r?\n/)) {
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(rawLine)
      if (close && close[1][0] === fence.char && close[1].length >= fence.len) { fence = null; continue }
      pushLine(rawLine.replace(/[ \t]+/g, ' ').trim())
      continue
    }
    const stripped = stripComments(rawLine, comment)
    comment = stripped.open
    const line = stripped.line
    if (!line.trim()) continue

    const open = FENCE.exec(line)
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = { char: open[1][0], len: open[1].length }
      continue
    }

    const h = HEADING.exec(line)
    if (h) {
      const parsed = inline(h[2] ?? '')
      links.push(...parsed.links)
      addTags(parsed.tags)
      flush()
      current = { heading: parsed.plain, level: h[1].length, lines: parsed.plain ? [parsed.plain] : [] }
      if (h1 === undefined && h[1].length === 1 && parsed.plain) h1 = parsed.plain
      continue
    }

    const block = stripBlock(line)
    if (!block) continue
    const parsed = inline(block.line)
    links.push(...parsed.links)
    addTags(parsed.tags)
    pushLine(block.table ? parsed.plain.replace(/(?<!\\)\|/g, ' ').replace(/ {2,}/g, ' ').trim() : parsed.plain)
  }
  flush()
  return { ...(h1 !== undefined ? { h1 } : {}), sections, links, tags }
}
