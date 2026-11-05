// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Morceaux de note integrables, comme dans Obsidian :
//   ![[note#Titre]]          la section sous ce titre (titre compris),
//                            jusqu'au titre suivant de meme niveau ou plus haut ;
//   ![[note#Titre#Sous-titre]] un titre cherche sous un autre ;
//   ![[note#^id]]            le bloc marque « ^id » en fin de ligne : un
//                            paragraphe, un element de liste (avec ses
//                            sous-elements) ; « ^id » seul sur sa ligne
//                            designe le bloc juste au-dessus (tableau,
//                            citation, liste entiere).
// Les marqueurs « ^id » ne s'affichent pas dans le rendu.

export type EmbedSubpath =
  | { kind: 'heading'; headings: string[] }
  | { kind: 'block'; id: string }

const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/
const BLOCK_ID_RE = /(?:^|[ \t])\^([A-Za-z0-9-]+)[ \t]*$/
const BLOCK_ID_ONLY_RE = /^[ \t]*\^([A-Za-z0-9-]+)[ \t]*$/
const LIST_ITEM_RE = /^([ \t]*)(?:[-*+]|\d+[.)])[ \t]/

/** Ce qui suit le premier « # » du lien (sans l'alias). Null si rien. */
export function parseSubpath(fragment: string): EmbedSubpath | null {
  const text = fragment.trim()
  if (!text) return null
  if (text.startsWith('^')) {
    const id = text.slice(1).trim()
    return id ? { kind: 'block', id } : null
  }
  const headings = text.split('#').map(h => h.trim()).filter(Boolean)
  return headings.length ? { kind: 'heading', headings } : null
}

/** Libelle court du morceau, pour l'en-tete de l'integration. */
export function describeSubpath(subpath: EmbedSubpath): string {
  return subpath.kind === 'block' ? `^${subpath.id}` : subpath.headings.join(' › ')
}

interface Line { text: string; inCode: boolean }

function scan(markdown: string): Line[] {
  const lines = markdown.split('\n')
  const out: Line[] = []
  let fence: string | null = null
  for (const text of lines) {
    const m = text.match(FENCE_RE)
    if (fence) {
      out.push({ text, inCode: true })
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !text.trim().slice(m[1].length).trim()) fence = null
      continue
    }
    if (m) { fence = m[1]; out.push({ text, inCode: true }); continue }
    out.push({ text, inCode: false })
  }
  return out
}

// Comme Obsidian : casse, espaces et mise en forme legere ne comptent pas.
function normalizeHeading(text: string): string {
  return text
    .replace(BLOCK_ID_RE, '')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/[*_`~=]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function headingAt(line: Line): { level: number; text: string } | null {
  if (line.inCode) return null
  const m = line.text.match(HEADING_RE)
  return m ? { level: m[1].length, text: m[2] } : null
}

function extractHeading(lines: Line[], wanted: string[]): string | null {
  const targets = wanted.map(normalizeHeading)
  // Chaque titre demande doit se trouver sous le precedent (niveau plus bas).
  let step = 0
  let parentLevel = 0
  let start = -1
  let level = 0
  for (let i = 0; i < lines.length; i++) {
    const h = headingAt(lines[i])
    if (!h) continue
    if (step > 0 && h.level <= parentLevel) { step = 0; parentLevel = 0 }
    if (normalizeHeading(h.text) !== targets[step]) continue
    if (step === targets.length - 1) { start = i; level = h.level; break }
    step++
    parentLevel = h.level
  }
  if (start < 0) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const h = headingAt(lines[i])
    if (h && h.level <= level) { end = i; break }
  }
  return trimBlank(lines.slice(start, end).map(l => l.text))
}

function isBlank(line: Line | undefined): boolean {
  return !line || (!line.inCode && line.text.trim() === '')
}

function indentOf(text: string): number {
  const m = text.match(/^[ \t]*/)
  return m ? m[0].replace(/\t/g, '    ').length : 0
}

function extractBlock(lines: Line[], id: string): string | null {
  const at = lines.findIndex(l => !l.inCode && l.text.match(BLOCK_ID_RE)?.[1] === id)
  if (at < 0) return null
  const line = lines[at]

  // « ^id » seul : le bloc juste au-dessus (sans ligne vide entre les deux,
  // ou une seule, comme apres un tableau ou une liste).
  if (BLOCK_ID_ONLY_RE.test(line.text)) {
    let end = at - 1
    if (isBlank(lines[end])) end--
    if (end < 0 || isBlank(lines[end])) return null
    let start = end
    while (start > 0 && !isBlank(lines[start - 1]) && !headingAt(lines[start])) start--
    return trimBlank(lines.slice(start, end + 1).map(l => l.text))
  }

  // Un titre marque : sa section.
  const h = headingAt(line)
  if (h) return extractHeading(lines.slice(at), [h.text])

  // Un element de liste : lui et ses sous-elements.
  const item = line.text.match(LIST_ITEM_RE)
  if (item) {
    const base = indentOf(line.text)
    let end = at + 1
    while (end < lines.length) {
      const next = lines[end]
      if (isBlank(next)) break
      if (!next.inCode && indentOf(next.text) <= base) break
      end++
    }
    // Retire l'indentation commune : le morceau se lit comme une liste a part.
    const slice = lines.slice(at, end).map(l => l.text)
    return trimBlank(slice.map(t => dedent(t, base)))
  }

  // Un paragraphe : de la ligne vide precedente a la ligne marquee.
  let start = at
  while (start > 0 && !isBlank(lines[start - 1]) && !headingAt(lines[start - 1])) start--
  return trimBlank(lines.slice(start, at + 1).map(l => l.text))
}

function dedent(text: string, columns: number): string {
  let i = 0
  let col = 0
  while (i < text.length && col < columns && (text[i] === ' ' || text[i] === '\t')) {
    col += text[i] === '\t' ? 4 : 1
    i++
  }
  return text.slice(i)
}

function trimBlank(lines: string[]): string {
  let s = 0
  let e = lines.length
  while (s < e && !lines[s].trim()) s++
  while (e > s && !lines[e - 1].trim()) e--
  return lines.slice(s, e).join('\n')
}

/**
 * Le morceau demande d'une note (sans frontmatter), ou null s'il n'existe
 * pas. Les marqueurs « ^id » sont retires du resultat.
 */
export function extractSubpath(markdown: string, subpath: EmbedSubpath): string | null {
  const lines = scan(markdown)
  const part = subpath.kind === 'heading'
    ? extractHeading(lines, subpath.headings)
    : extractBlock(lines, subpath.id)
  return part === null ? null : stripBlockIds(part)
}

/**
 * Retire les marqueurs « ^id » de fin de ligne (hors blocs de code), pour
 * qu'ils ne s'affichent pas dans le rendu. Une ligne faite du seul marqueur
 * disparait.
 */
export function stripBlockIds(markdown: string): string {
  if (!markdown.includes('^')) return markdown
  const out: string[] = []
  for (const line of scan(markdown)) {
    if (line.inCode) { out.push(line.text); continue }
    if (BLOCK_ID_ONLY_RE.test(line.text)) continue
    out.push(line.text.replace(BLOCK_ID_RE, ''))
  }
  return out.join('\n')
}
