// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Edition du frontmatter d'une note, sans dependance. Fonctions PURES : elles
// rendent le nouveau texte de la note. L'appelant l'applique comme une frappe
// (delta minimal, voir minimalTextChange), donc par la synchro CRDT.
//
// Regle : toucher le moins de texte possible. Seule l'entree visee change ;
// le reste du bloc (commentaires, ordre, cles inconnues, cartes imbriquees,
// fins de ligne) reste tel quel. Une valeur reecrite garde son style : liste
// en ligne `[a, b]` ou en bloc (`- a`, avec la meme indentation), commentaire
// de fin de ligne.
//
// Meme sous-ensemble de YAML que la lecture (frontmatter.ts) : une entree est
// une ligne `cle: valeur` en colonne 0, suivie de ses lignes de continuation
// (lignes indentees, ou elements `- x`).
import type { FrontmatterValue } from './frontmatter'
import { findFrontmatter, parseScalar } from './frontmatter'

/** Une entree `cle: valeur` du bloc, en positions absolues dans la note. */
interface Entry {
  key: string
  /** Le jeton de la cle (guillemets compris). */
  keyStart: number
  keyEnd: number
  /** Debut de la ligne de la cle. */
  lineStart: number
  /** Texte apres `:` sur la ligne de la cle, sans les espaces de tete. */
  inline: string
  /** Fin de la derniere ligne de l'entree (sans son saut de ligne). */
  end: number
  /** Prefixe des elements d'une liste en bloc (`  - `), s'il y en a. */
  itemPrefix: string | null
}

interface Scan {
  /** Debut et fin du YAML (sans les lignes `---`). */
  yamlStart: number
  yamlEnd: number
  /** Fin du bloc complet, apres la ligne de fermeture. */
  blockEnd: number
  eol: string
  entries: Entry[]
}

const KEY_LINE = /^([^\s:#-][^:]*?|"[^"]+"|'[^']+'):(?:\s+(.*)|\s*)$/

function eolOf(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

function readKey(token: string): string {
  return token.startsWith('"') || token.startsWith("'") ? String(parseScalar(token)) : token.trim()
}

/** Decoupe le bloc en entrees. Null si la note n'a pas de frontmatter. */
function scan(markdown: string): Scan | null {
  const block = findFrontmatter(markdown)
  if (!block) return null
  const open = /^---[ \t]*\r?\n/.exec(markdown)
  if (!open) return null
  const yamlStart = open[0].length
  const yamlEnd = yamlStart + block.yaml.length
  const entries: Entry[] = []
  let current: Entry | null = null
  let pos = yamlStart
  while (pos < yamlEnd) {
    const nl = markdown.indexOf('\n', pos)
    const lineEnd = nl < 0 || nl > yamlEnd ? yamlEnd : nl
    const raw = markdown.slice(pos, lineEnd)
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const contentEnd = pos + line.length
    const kv = KEY_LINE.exec(line)
    if (kv) {
      current = {
        key: readKey(kv[1]),
        keyStart: pos,
        keyEnd: pos + kv[1].length,
        lineStart: pos,
        inline: (kv[2] ?? '').trim(),
        end: contentEnd,
        itemPrefix: null,
      }
      entries.push(current)
    } else if (current && line.trim() && !/^#/.test(line) && (/^\s/.test(line) || /^-(\s|$)/.test(line))) {
      // Continuation : element de liste ou ligne indentee.
      current.end = contentEnd
      const item = /^(\s*-\s+)/.exec(line)
      if (item && current.itemPrefix === null && current.inline === '') current.itemPrefix = item[1]
    } else if (line.trim() && !/^\s*#/.test(line)) {
      // Ligne inconnue en colonne 0 : fin de l'entree courante.
      current = null
    }
    // Lignes vides et commentaires : l'entree continue si une continuation suit.
    if (lineEnd >= yamlEnd) break
    pos = lineEnd + 1
  }
  return { yamlStart, yamlEnd, blockEnd: block.end, eol: eolOf(markdown), entries }
}

function findEntry(s: Scan, key: string): Entry | undefined {
  // La lecture garde la DERNIERE occurrence d'une cle en double : on edite celle-la.
  for (let i = s.entries.length - 1; i >= 0; i--) if (s.entries[i].key === key) return s.entries[i]
  return undefined
}

// ── Ecriture des valeurs ─────────────────────────────────────────────────────

function quote(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t') + '"'
}

/** Vrai si la chaine, ecrite nue, ne se relirait pas a l'identique. */
function needsQuotes(s: string, inList: boolean): boolean {
  if (s === '' || s !== s.trim()) return true
  if (/[\n\r\t]/.test(s)) return true
  if (/^(- |-$|[?:,[\]{}#&*!|>'"%@`])/.test(s)) return true
  if (/:(\s|$)/.test(s) || /\s#/.test(s)) return true
  // Un element de liste se relit toujours en chaine : 2 ou true peuvent rester nus.
  if (!inList && parseScalar(s) !== s) return true
  return false
}

/** Une valeur scalaire en YAML. Null rend une chaine vide (`cle:`). */
export function formatYamlScalar(value: string | number | boolean | null): string {
  if (value === null) return ''
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  return needsQuotes(value, false) ? quote(value) : value
}

function formatListItem(value: string, inline: boolean): string {
  if (needsQuotes(value, true) || (inline && /[,[\]{}]/.test(value))) return quote(value)
  return value
}

/** Une cle en YAML : nue si possible, sinon entre guillemets. */
export function formatYamlKey(key: string): string {
  if (key && key === key.trim() && /^[^\s:#\-"'][^:]*$/.test(key) && !/\s#/.test(key)) return key
  return key.includes('"') && !key.includes("'") ? `'${key}'` : `"${key.replace(/"/g, '')}"`
}

/** Commentaire de fin de ligne d'une valeur nue (` # ...`), a garder. */
function trailingComment(inline: string): string {
  if (inline.startsWith('"') || inline.startsWith("'")) return ''
  const i = inline.search(/\s#/)
  return i < 0 ? '' : ' ' + inline.slice(i).trim()
}

/** Texte d'une entree complete : ligne de la cle et lignes des elements. */
function formatEntry(keyToken: string, value: FrontmatterValue, eol: string, previous?: Entry): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return `${keyToken}: []`
    const wasInline = !!previous && previous.inline.startsWith('[') && previous.inline !== '[]'
    if (wasInline) return `${keyToken}: [${value.map(v => formatListItem(v, true)).join(', ')}]`
    const prefix = previous?.itemPrefix ?? '  - '
    return [`${keyToken}:`, ...value.map(v => prefix + formatListItem(v, false))].join(eol)
  }
  const scalar = formatYamlScalar(value)
  const comment = previous && previous.itemPrefix === null ? trailingComment(previous.inline) : ''
  return (scalar === '' ? `${keyToken}:` : `${keyToken}: ${scalar}`) + comment
}

// ── Operations ──────────────────────────────────────────────────────────────

/**
 * Pose une propriete : remplace sa valeur si elle existe (a sa place), sinon
 * l'ajoute a la fin du bloc. Cree le bloc si la note n'en a pas.
 */
export function setFrontmatterValue(markdown: string, key: string, value: FrontmatterValue): string {
  const s = scan(markdown)
  if (!s) {
    const eol = eolOf(markdown)
    return `---${eol}${formatEntry(formatYamlKey(key), value, eol)}${eol}---${eol}${markdown}`
  }
  const entry = findEntry(s, key)
  if (entry) {
    const keyToken = markdown.slice(entry.keyStart, entry.keyEnd)
    const text = formatEntry(keyToken, value, s.eol, entry)
    return markdown.slice(0, entry.lineStart) + text + markdown.slice(entry.end)
  }
  const text = formatEntry(formatYamlKey(key), value, s.eol)
  if (s.yamlEnd === s.yamlStart) {
    return markdown.slice(0, s.yamlStart) + text + s.eol + markdown.slice(s.yamlStart)
  }
  return markdown.slice(0, s.yamlEnd) + s.eol + text + markdown.slice(s.yamlEnd)
}

/**
 * Retire une propriete et ses lignes. Si le bloc n'a plus rien (ni cle ni
 * commentaire), il disparait avec ses lignes `---`.
 */
export function removeFrontmatterKey(markdown: string, key: string): string {
  const s = scan(markdown)
  const entry = s && findEntry(s, key)
  if (!s || !entry) return markdown
  let from = entry.lineStart
  let to = entry.end
  if (to < s.yamlEnd) {
    // Retire aussi le saut de ligne qui suit.
    to = markdown.indexOf('\n', to) + 1
  } else if (from > s.yamlStart) {
    // Derniere ligne du YAML : retire le saut de ligne qui la precede.
    from = markdown.lastIndexOf('\n', from - 1)
    if (from > 0 && markdown[from - 1] === '\r') from--
  }
  const next = markdown.slice(0, from) + markdown.slice(to)
  const rest = scan(next)
  if (rest && !next.slice(rest.yamlStart, rest.yamlEnd).trim()) return next.slice(rest.blockEnd)
  return next
}

/**
 * Renomme une propriete, sans toucher a sa valeur. Ne fait rien si `to`
 * existe deja (deux cles du meme nom se masqueraient) ou si `from` manque.
 */
export function renameFrontmatterKey(markdown: string, from: string, to: string): string {
  const s = scan(markdown)
  if (!s || from === to || !to.trim()) return markdown
  if (findEntry(s, to)) return markdown
  const entry = findEntry(s, from)
  if (!entry) return markdown
  return markdown.slice(0, entry.keyStart) + formatYamlKey(to.trim()) + markdown.slice(entry.keyEnd)
}

/** Cles du frontmatter, dans l'ordre du texte (une cle en double compte une fois). */
export function frontmatterKeys(markdown: string): string[] {
  const s = scan(markdown)
  if (!s) return []
  return [...new Set(s.entries.map(e => e.key))]
}

/**
 * Le plus petit remplacement qui fait passer de `before` a `after` : une
 * plage [from, to) de `before` a remplacer par `insert`. Null s'ils sont
 * egaux. Sert a appliquer une edition comme une frappe (CRDT, CodeMirror).
 */
export function minimalTextChange(before: string, after: string): { from: number; to: number; insert: string } | null {
  if (before === after) return null
  const max = Math.min(before.length, after.length)
  let start = 0
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++
  // Ne pas couper une paire de substitution (emoji).
  if (start > 0 && start < max && isHighSurrogate(before.charCodeAt(start - 1))) start--
  let end = 0
  while (end < max - start && before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)) end++
  if (end > 0 && isLowSurrogate(before.charCodeAt(before.length - end))) end--
  return { from: start, to: before.length - end, insert: after.slice(start, after.length - end) }
}

function isHighSurrogate(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff
}

function isLowSurrogate(c: number): boolean {
  return c >= 0xdc00 && c <= 0xdfff
}
