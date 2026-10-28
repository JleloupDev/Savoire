// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Lecture TYPEE du frontmatter d'une note (le bloc YAML `---` en tete).
// Un seul analyseur pour toute l'appli : panneau de proprietes, index
// (pair indexeur, bureau, navigateur), bases. Sans dependance.
//
// Sous-ensemble de YAML pris en charge, celui qu'ecrit Obsidian :
//  - `cle: valeur` (la cle peut contenir des espaces) ;
//  - chaines nues ou entre guillemets simples / doubles ;
//  - nombres, true / false, null / ~ ;
//  - listes en ligne `[a, b]` et en bloc (`- a` sous la cle, indente ou non).
// Le reste (cartes imbriquees, blocs `|` / `>`) est ignore sans erreur.
// Les dates restent des chaines ISO : elles se comparent comme telles.

/** Meme forme que PropertyValue (plugin-api). */
export type FrontmatterValue = string | number | boolean | null | string[]

export interface FrontmatterBlock {
  /** Le YAML, sans les lignes `---`. */
  yaml: string
  /** Debut du bloc (la premiere ligne `---`), en caracteres. */
  start: number
  /** Fin du bloc, apres la ligne `---` de fermeture et son saut de ligne. */
  end: number
}

/** Le bloc de frontmatter en tete du texte, ou null. */
export function findFrontmatter(markdown: string): FrontmatterBlock | null {
  const m = /^---[ \t]*\r?\n([\s\S]*?)(?:\r?\n)?^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(markdown)
  if (!m || m.index !== 0) return null
  return { yaml: m[1], start: 0, end: m[0].length }
}

/** Le texte de la note sans son frontmatter. */
export function stripFrontmatter(markdown: string): string {
  const block = findFrontmatter(markdown)
  return block ? markdown.slice(block.end) : markdown
}

function unquote(s: string): string | null {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\(["\\nt])/g, (_, c: string) => c === 'n' ? '\n' : c === 't' ? '\t' : c)
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'")
  return null
}

/** Retire un commentaire ` # ...` hors guillemets. */
function stripComment(s: string): string {
  if (s.startsWith('"') || s.startsWith("'")) return s
  const i = s.search(/\s#/)
  return i < 0 ? s : s.slice(0, i).trimEnd()
}

/** Valeur scalaire YAML : chaine, nombre, booleen ou null. */
export function parseScalar(raw: string): string | number | boolean | null {
  const s = stripComment(raw.trim())
  const quoted = unquote(s)
  if (quoted !== null) return quoted
  if (s === '' || s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null
  if (/^(true|True|TRUE)$/.test(s)) return true
  if (/^(false|False|FALSE)$/.test(s)) return false
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return Number(s)
  return s
}

function listItem(raw: string): string | null {
  const v = parseScalar(raw)
  return v === null ? null : String(v)
}

/** Decoupe `a, "b, c", d` en respectant les guillemets. */
function splitInlineList(inner: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  for (const ch of inner) {
    if (quote) {
      cur += ch
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      cur += ch
      quote = ch
    } else if (ch === ',') {
      out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out.map(s => s.trim()).filter(Boolean)
}

/** Proprietes du frontmatter, typees. Pas de frontmatter : objet vide. */
export function parseFrontmatter(markdown: string): Record<string, FrontmatterValue> {
  const block = findFrontmatter(markdown)
  return block ? parseFrontmatterYaml(block.yaml) : {}
}

/** Proprietes d'un YAML de frontmatter (sans les lignes `---`). */
export function parseFrontmatterYaml(yaml: string): Record<string, FrontmatterValue> {
  const result: Record<string, FrontmatterValue> = {}
  const lines = yaml.split(/\r?\n/)
  let listKey: string | null = null
  for (const line of lines) {
    if (!line.trim() || /^\s*#/.test(line)) continue
    const item = /^\s*-\s+(.*)$/.exec(line) ?? /^\s*-$/.exec(line)
    if (listKey && item) {
      const v = listItem(item[1] ?? '')
      const cur = result[listKey]
      const arr = Array.isArray(cur) ? cur : []
      if (v !== null) arr.push(v)
      result[listKey] = arr
      continue
    }
    // Une ligne indentee qui n'est pas un element de liste : carte imbriquee, ignoree.
    if (/^\s/.test(line)) continue
    listKey = null
    const kv = /^([^\s:#-][^:]*?|"[^"]+"|'[^']+'):(?:\s+(.*)|\s*)$/.exec(line)
    if (!kv) continue
    const key = unquote(kv[1]) ?? kv[1].trim()
    const value = (kv[2] ?? '').trim()
    if (value === '' || value === '[]') {
      // Liste en bloc a suivre, ou valeur vide.
      result[key] = value === '[]' ? [] : null
      if (value === '') listKey = key
      continue
    }
    if (value.startsWith('[') && value.endsWith(']')) {
      result[key] = splitInlineList(value.slice(1, -1)).map(listItem).filter((v): v is string => v !== null)
      continue
    }
    if (value === '|' || value === '>' || value.startsWith('|') || value.startsWith('>')) continue
    result[key] = parseScalar(value)
  }
  return result
}
