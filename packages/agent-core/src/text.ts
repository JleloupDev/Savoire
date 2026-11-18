// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Petites operations sur le texte d'une note, communes aux deux hotes : on
// calcule ici QUOI changer (une plage et un texte), l'hote l'applique a son
// CRDT. Ainsi une modification d'agent est minimale : elle ne remplace jamais
// la note entiere.

/** Position de la n-ieme occurrence (a partir de 0) de `find`, ou -1. */
export function findOccurrence(content: string, find: string, occurrence = 0): number {
  if (!find) return -1
  let at = -1
  for (let i = 0; i <= occurrence; i++) {
    at = content.indexOf(find, at + 1)
    if (at < 0) return -1
  }
  return at
}

/** Nombre d'occurrences de `find` (sans chevauchement). */
export function countOccurrences(content: string, find: string): number {
  if (!find) return 0
  let n = 0
  for (let at = content.indexOf(find); at >= 0; at = content.indexOf(find, at + find.length)) n++
  return n
}

export interface TextChange {
  from: number
  to: number
  text: string
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/

/** Une valeur de propriete, ecrite en YAML simple (texte, nombre, booleen, liste). */
export function yamlValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(v => yamlScalar(v)).join(', ')}]`
  return yamlScalar(value)
}

function yamlScalar(v: unknown): string {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (v === null || v === undefined) return ''
  const s = String(v)
  return /^[\w .\-/àâäéèêëîïôöùûüç]+$/i.test(s) && !/^(true|false|null|yes|no|\d[\d.]*)$/i.test(s) && s.trim() === s ? s : JSON.stringify(s)
}

/**
 * Pose une propriete dans le frontmatter (le cree s'il manque). `value` null :
 * la retire. Rend la plage a remplacer, ou null si rien ne change.
 */
export function setPropertyChange(content: string, name: string, value: unknown): TextChange | null {
  if (!/^[\w\-. ]{1,100}$/.test(name)) throw new Error(`nom de propriete invalide : ${name}`)
  const line = value === null ? null : `${name}: ${yamlValue(value)}`
  const m = FRONTMATTER.exec(content)
  if (!m) {
    if (line === null) return null
    return { from: 0, to: 0, text: `---\n${line}\n---\n` }
  }
  const body = m[1]!
  const start = content.indexOf(body)
  const lines = body.split(/\r?\n/)
  const key = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`)
  const at = lines.findIndex(l => key.test(l))
  let next: string[]
  if (at < 0) {
    if (line === null) return null
    next = [...lines, line]
  } else {
    // Une liste YAML en plusieurs lignes (« - a ») suit sa cle : elle part avec elle.
    let end = at + 1
    while (end < lines.length && /^\s+-\s|^\s+\S/.test(lines[end]!)) end++
    next = [...lines.slice(0, at), ...(line === null ? [] : [line]), ...lines.slice(end)]
  }
  const text = next.join('\n')
  if (text === body) return null
  return { from: start, to: start + body.length, text }
}

/** Un chemin de note propre : sans « / » au debut, avec .md si aucune extension. */
export function notePath(path: string): string {
  const p = path.trim().replace(/^\/+/, '').replace(/\/{2,}/g, '/')
  if (!p || p.endsWith('/')) throw new Error('chemin de note vide')
  if (p.split('/').some(seg => seg === '..' || seg === '.')) throw new Error('chemin invalide')
  return /\.[a-z0-9]{1,8}$/i.test(p.split('/').pop()!) ? p : `${p}.md`
}

/** Le dossier d'un chemin (« A/B/note.md » -> « A/B »). */
export function folderOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

/** Le nom d'une note, sans dossier ni extension. */
export function titleOf(path: string): string {
  const name = path.split('/').pop() ?? path
  return name.replace(/\.[a-z0-9]{1,8}$/i, '')
}
