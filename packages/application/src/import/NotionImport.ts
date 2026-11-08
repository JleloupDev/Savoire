// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Import d'un export Notion (« Markdown & CSV », archive .zip) en vault Savoire.
//
// Ce que Notion produit, et ce qu'on en fait :
//  - « Page 0123…cdef.md » + dossier « Page 0123…cdef/ » (sous-pages, images) :
//    l'identifiant de 32 caracteres est retire. « Page.md » et « Page/ » sont
//    deja la convention des notes de dossier de Savoire ;
//  - base de donnees : « Base 0123….csv » (et « …_all.csv », toutes les
//    lignes) + dossier des lignes. Elle devient « Base.base », dont les
//    lignes sont les notes du dossier « Base/ » (la source par defaut d'une
//    base). Les valeurs du CSV passent dans le frontmatter de chaque ligne ;
//    une ligne sans page devient une note vide avec ses valeurs ;
//  - liens entre pages ([Titre](Autre%20page%200123….md)) : liens [[...]]
//    vers le nouveau chemin ; images : ![[...]]. Les liens externes restent.
//
// Pur : des octets en entree, des fichiers en sortie. Le depot dans un vault
// (nouveau vault du serveur ou dossier du poste) se fait ailleurs.

import type { ArchiveFile } from './zipReader'

export interface NotionImportReport {
  pages: number
  databases: number
  /** Lignes de bases (pages comprises). */
  rows: number
  /** Images et autres fichiers. */
  files: number
  /** Liens vers une page absente de l'export (laisses tels quels). */
  unresolvedLinks: number
  warnings: string[]
}

export interface NotionImportResult {
  files: ArchiveFile[]
  report: NotionImportReport
}

const ID_RE = /\s+[0-9a-f]{32}$/i
const IGNORED = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$)/

const enc = new TextEncoder()
const dec = new TextDecoder('utf-8')

/** Convertit les fichiers d'un export Notion en fichiers d'un vault Savoire. */
export function convertNotionExport(input: readonly ArchiveFile[]): NotionImportResult {
  const report: NotionImportReport = { pages: 0, databases: 0, rows: 0, files: 0, unresolvedLinks: 0, warnings: [] }
  const files = stripWrapper(input.filter(f => !IGNORED.test(f.path)))

  // ── Nouveaux chemins : identifiants retires, homonymes numerotes ─────────
  const names = new Namer()
  const newPath = new Map<string, string>()
  for (const f of files) newPath.set(f.path, names.map(f.path))

  // ── Bases : un CSV par base (« _all » de preference : toutes les lignes) ──
  const databases = new Map<string, { csv: ArchiveFile; basePath: string; folder: string }>()
  for (const f of files) {
    if (!/\.csv$/i.test(f.path)) continue
    const stem = f.path.replace(/\.csv$/i, '').replace(/_all$/, '')
    const prev = databases.get(stem)
    if (prev && !/_all\.csv$/i.test(f.path)) continue
    const mapped = newPath.get(f.path)!.replace(/(_all)?\.csv$/i, '')
    databases.set(stem, { csv: f, basePath: `${mapped}.base`, folder: mapped })
  }
  // Un lien vers le CSV d'une base mene a la base.
  for (const f of files) {
    const db = /\.csv$/i.test(f.path) ? databases.get(f.path.replace(/\.csv$/i, '').replace(/_all$/, '')) : undefined
    if (db) newPath.set(f.path, db.basePath)
  }

  // ── Lignes des bases : valeurs du CSV, par titre ─────────────────────────
  /** Frontmatter a poser, par chemin d'origine de page. */
  const rowValues = new Map<string, { values: [string, YamlValue][]; headers: Set<string> }>()
  const out: ArchiveFile[] = []
  for (const [stem, db] of databases) {
    report.databases++
    const table = parseCsv(stripBom(dec.decode(db.csv.bytes)))
    if (table.length === 0) continue
    const [header, ...rows] = table
    const columns = header.map(h => h.trim())
    const kinds = columns.map((_, i) => columnKind(rows.map(r => (r[i] ?? '').trim())))
    // Pages du dossier de la base, par titre.
    const pages = new Map<string, string[]>()
    for (const f of files) {
      if (!f.path.startsWith(`${stem}/`) || !/\.md$/i.test(f.path) || f.path.slice(stem.length + 1).includes('/')) continue
      const title = stripId(baseName(f.path).replace(/\.md$/i, ''))
      pages.set(title, [...(pages.get(title) ?? []), f.path])
    }
    for (const row of rows) {
      if (row.every(c => !c.trim())) continue
      report.rows++
      const title = (row[0] ?? '').trim() || 'Sans titre'
      const values: [string, YamlValue][] = []
      columns.forEach((key, i) => {
        if (i === 0 || !key) return
        const v = convert((row[i] ?? '').trim(), kinds[i])
        if (v !== null) values.push([key, v])
      })
      const page = pages.get(title)?.shift()
      if (page) rowValues.set(page, { values, headers: new Set(columns) })
      else {
        // Ligne sans page : une note avec ses valeurs.
        const path = names.fresh(db.folder, title, '.md')
        out.push({ path, bytes: enc.encode(`${frontmatter(values)}# ${title}\n`) })
      }
    }
    // La base : un document vide, dont la source par defaut est son dossier.
    out.push({ path: db.basePath, bytes: new Uint8Array() })
  }

  // ── Pages et fichiers ─────────────────────────────────────────────────────
  for (const f of files) {
    if (/\.csv$/i.test(f.path)) continue
    const target = newPath.get(f.path)!
    if (!/\.md$/i.test(f.path)) {
      report.files++
      out.push({ path: target, bytes: f.bytes })
      continue
    }
    let text = stripBom(dec.decode(f.bytes))
    text = rewriteLinks(text, f.path, newPath, report)
    const row = rowValues.get(f.path)
    if (row) text = frontmatter(row.values) + dropPropertyLines(text, row.headers)
    else report.pages++
    out.push({ path: target, bytes: enc.encode(text) })
  }
  if (report.unresolvedLinks) report.warnings.push(`${report.unresolvedLinks} lien(s) vers des pages absentes de l’export, laissés tels quels.`)
  return { files: out.sort((a, b) => a.path.localeCompare(b.path)), report }
}

// ── Chemins ───────────────────────────────────────────────────────────────

/** Retire l'identifiant Notion d'un nom (sans extension). */
export function stripId(stem: string): string {
  const s = stem.replace(ID_RE, '').trim()
  return s || stem
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function dirName(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

/** Un export enveloppe dans un seul dossier (« Export-… ») : on le retire. */
function stripWrapper(files: ArchiveFile[]): ArchiveFile[] {
  const first = new Set(files.map(f => (f.path.includes('/') ? f.path.slice(0, f.path.indexOf('/')) : '')))
  if (first.size !== 1) return files
  const [top] = first
  if (!top || files.some(f => f.path === `${top}.md`)) return files
  return files.map(f => ({ path: f.path.slice(top.length + 1), bytes: f.bytes }))
}

/**
 * Nouveaux noms, dossier par dossier. Une page et son dossier de sous-pages
 * gardent le meme nom ; deux pages homonymes (identifiants differents)
 * deviennent « Nom » et « Nom (2) ».
 */
class Namer {
  /** Par dossier (nouveau chemin) : radical d'origine -> nouveau radical. */
  private readonly stems = new Map<string, Map<string, string>>()
  private readonly used = new Map<string, Set<string>>()

  map(path: string): string {
    const parts = path.split('/')
    let parent = ''
    const result: string[] = []
    parts.forEach((seg, i) => {
      const isFile = i === parts.length - 1
      const { stem, ext } = isFile ? splitExt(seg) : { stem: seg, ext: '' }
      const allSuffix = isFile && /\.csv$/i.test(seg) && /_all$/.test(stem) ? '_all' : ''
      const key = allSuffix ? stem.slice(0, -4) : stem
      const name = this.stemFor(parent, key) + allSuffix + ext
      result.push(name)
      parent = parent ? `${parent}/${this.stemFor(parent, key)}` : this.stemFor(parent, key)
    })
    return result.join('/')
  }

  /** Nom libre dans un dossier (ligne de base sans page). */
  fresh(dir: string, title: string, ext: string): string {
    const stem = this.claim(dir, `\u0000${title}\u0000${Math.random()}`, safeName(title))
    return dir ? `${dir}/${stem}${ext}` : `${stem}${ext}`
  }

  private stemFor(parent: string, original: string): string {
    const known = this.stems.get(parent)?.get(original)
    if (known) return known
    return this.claim(parent, original, safeName(stripId(original)))
  }

  private claim(parent: string, original: string, wanted: string): string {
    const used = this.used.get(parent) ?? new Set<string>()
    this.used.set(parent, used)
    let name = wanted
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${wanted} (${n})`
    used.add(name.toLowerCase())
    const map = this.stems.get(parent) ?? new Map<string, string>()
    this.stems.set(parent, map)
    map.set(original, name)
    return name
  }
}

function splitExt(name: string): { stem: string; ext: string } {
  const i = name.lastIndexOf('.')
  return i <= 0 ? { stem: name, ext: '' } : { stem: name.slice(0, i), ext: name.slice(i) }
}

function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|#^[\]]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Sans titre'
}

// ── Liens ─────────────────────────────────────────────────────────────────

const LINK_RE = /(!?)\[([^\]\n]*)\]\(([^)\n]+?)\)/g

function rewriteLinks(text: string, from: string, newPath: Map<string, string>, report: NotionImportReport): string {
  const dir = dirName(from)
  return text.replace(LINK_RE, (whole, bang: string, label: string, rawHref: string) => {
    const href = rawHref.trim().replace(/^<|>$/g, '').replace(/\s+"[^"]*"$/, '')
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#')) return whole
    let decoded: string
    try { decoded = decodeURIComponent(href) } catch { decoded = href }
    const [file] = decoded.split('#')
    const resolved = normalize(dir ? `${dir}/${file}` : file)
    // Lien vers « Base.csv » quand seule « Base_all.csv » est dans l'export (ou l'inverse).
    const target = newPath.get(resolved)
      ?? (/\.csv$/i.test(resolved) ? newPath.get(resolved.replace(/(_all)?\.csv$/i, '_all.csv')) ?? newPath.get(resolved.replace(/_all\.csv$/i, '.csv')) : undefined)
    if (!target) {
      if (/\.(md|csv)$/i.test(file)) report.unresolvedLinks++
      return whole
    }
    const text = label.replace(/[|[\]]/g, ' ').trim()
    if (/\.md$/i.test(target)) {
      const ref = target.replace(/\.md$/i, '')
      // Le chemin complet evite toute ambiguite ; le texte affiche reste le titre.
      const shown = text || baseName(ref)
      return shown === ref ? `[[${ref}]]` : `[[${ref}|${shown}]]`
    }
    if (bang) return `![[${target}]]`
    return text && text !== baseName(target) ? `[[${target}|${text}]]` : `[[${target}]]`
  })
}

function normalize(path: string): string {
  const out: string[] = []
  for (const seg of path.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return out.join('/')
}

// ── Valeurs des bases ─────────────────────────────────────────────────────

type YamlValue = string | number | boolean | string[]
type ColumnKind = 'text' | 'number' | 'checkbox' | 'date' | 'list'

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const DATE_RE = /^([A-Za-z]+) (\d{1,2}), (\d{4})(?: \d{1,2}:\d{2}(?: ?[AP]M)?)?$/

function isoDate(value: string): string | null {
  const iso = /^(\d{4})[-/](\d{2})[-/](\d{2})/.exec(value)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  const m = DATE_RE.exec(value)
  if (!m) return null
  const month = MONTHS.indexOf(m[1].toLowerCase())
  if (month < 0) return null
  return `${m[3]}-${String(month + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`
}

/** Type d'une colonne, d'apres toutes ses valeurs non vides. */
export function columnKind(values: readonly string[]): ColumnKind {
  const filled = values.filter(v => v !== '')
  if (filled.length === 0) return 'text'
  if (filled.every(v => v === 'Yes' || v === 'No')) return 'checkbox'
  if (filled.every(v => /^-?\d+(\.\d+)?$/.test(v))) return 'number'
  if (filled.every(v => isoDate(v) !== null)) return 'date'
  // Choix multiples : « a, b, c », des elements courts, pas des phrases.
  if (filled.some(v => v.includes(', ')) && filled.every(v => !/[.!?]\s/.test(v) && v.split(', ').every(x => x.length <= 40))) return 'list'
  return 'text'
}

function convert(value: string, kind: ColumnKind): YamlValue | null {
  if (value === '') return null
  switch (kind) {
    case 'checkbox': return value === 'Yes'
    case 'number': return Number(value)
    case 'date': return isoDate(value) ?? value
    case 'list': return value.split(', ').map(x => x.trim()).filter(Boolean)
    default: return value
  }
}

function yamlScalar(v: string | number | boolean): string {
  if (typeof v !== 'string') return String(v)
  // Guillemets des qu'un lecteur YAML pourrait s'y tromper.
  if (v === '' || /^[\s\-?:,[\]{}#&*!|>'"%@`]|[:#]\s|\s$|^(true|false|null|yes|no|~)$/i.test(v) || /^-?\d/.test(v) && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return JSON.stringify(v)
  return v
}

function yamlKey(k: string): string {
  return /^[\p{L}\p{N}_][\p{L}\p{N}_ .()'/-]*$/u.test(k) ? k : JSON.stringify(k)
}

function frontmatter(values: readonly [string, YamlValue][]): string {
  if (values.length === 0) return ''
  const lines = values.map(([k, v]) => `${yamlKey(k)}: ${Array.isArray(v) ? `[${v.map(x => yamlScalar(x)).join(', ')}]` : yamlScalar(v)}`)
  return `---\n${lines.join('\n')}\n---\n`
}

/** Les lignes « Propriete: valeur » que Notion ecrit sous le titre d'une ligne. */
function dropPropertyLines(text: string, headers: Set<string>): string {
  const lines = text.split('\n')
  let i = 0
  if (/^#\s/.test(lines[0] ?? '')) i = 1
  while (i < lines.length && lines[i].trim() === '') i++
  const start = i
  while (i < lines.length) {
    const m = /^([^:]+):\s?(.*)$/.exec(lines[i])
    if (!m || !headers.has(m[1].trim())) break
    i++
  }
  if (i === start) return text
  return [...lines.slice(0, start), ...lines.slice(i).filter((l, k) => k > 0 || l.trim() !== '')].join('\n')
}

// ── CSV ───────────────────────────────────────────────────────────────────

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** CSV classique (RFC 4180) : guillemets, guillemets doubles, retours a la ligne dans un champ. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (c === '"') quoted = false
      else field += c
    } else if (c === '"' && field === '') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      rows.push(row); row = []
    } else field += c
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows.filter(r => !(r.length === 1 && r[0] === ''))
}
