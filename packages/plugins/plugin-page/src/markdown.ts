// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Export Markdown d'une page, pour l'indexation (recherche, liens, tags).
//
// Sens unique : la page n'est jamais relue depuis ce Markdown. Il doit donc
// surtout etre lisible et garder ce que l'index cherche : le texte, les
// titres, les [[liens]] vers les sous-pages.
import type { PmJson } from './adapter/convert'
import { parsePageFile } from './adapter/pageFile'
import { emojiOfColor, pageColorOf } from './highlight'

const MARK_DELIMS: Record<string, [string, string]> = {
  bold: ['**', '**'],
  italic: ['*', '*'],
  strike: ['~~', '~~'],
  code: ['`', '`'],
}

function inline(nodes: PmJson[] | undefined): string {
  let out = ''
  for (const n of nodes ?? []) {
    if (n.type === 'hardBreak') { out += '  \n'; continue }
    if (n.type !== 'text' || !n.text) continue
    let text = n.text
    let link: string | null = null
    for (const m of n.marks ?? []) {
      const d = MARK_DELIMS[m.type]
      if (d) text = d[0] + text + d[1]
      // Surlignage : ==texte==, ou ==🔴texte== en couleur (Obsidian, Plume).
      if (m.type === 'highlight') {
        const color = pageColorOf(m.attrs?.color)
        text = `==${color ? emojiOfColor(color) : ''}${text}==`
      }
      if (m.type === 'link' && typeof m.attrs?.href === 'string') link = m.attrs.href
    }
    out += link ? `[${text}](${link})` : text
  }
  return out
}

function indent(text: string, prefix: string, first = prefix): string {
  return text.split('\n').map((line, i) => (i === 0 ? first : (line ? prefix : prefix.trimEnd())) + line).join('\n')
}

function list(node: PmJson, ordered: boolean): string {
  const start = Number(node.attrs?.start ?? 1)
  return (node.content ?? []).map((item, i) => {
    let marker = ordered ? `${start + i}. ` : '- '
    if (item.type === 'taskItem') marker += item.attrs?.checked ? '[x] ' : '[ ] '
    const body = (item.content ?? []).map(block).join('\n')
    return indent(body, ' '.repeat(ordered ? marker.length : 2), marker)
  }).join('\n')
}

function block(node: PmJson): string {
  switch (node.type) {
    case 'paragraph': return inline(node.content)
    case 'heading': return '#'.repeat(Number(node.attrs?.level ?? 1)) + ' ' + inline(node.content)
    case 'blockquote': return indent((node.content ?? []).map(block).join('\n\n'), '> ')
    case 'codeBlock': {
      const code = (node.content ?? []).map(n => n.text ?? '').join('')
      const fence = '`'.repeat(Math.max(3, ...[...code.matchAll(/`+/g)].map(m => m[0].length + 1)))
      return `${fence}${node.attrs?.language ?? ''}\n${code}\n${fence}`
    }
    case 'horizontalRule': return '---'
    case 'bulletList': return list(node, false)
    case 'taskList': return list(node, false)
    case 'orderedList': return list(node, true)
    case 'pageLink': return `[[${String(node.attrs?.target ?? '')}]]`
    default: return (node.content ?? []).map(block).join('\n\n')
  }
}

/** Document ProseMirror -> Markdown. */
export function pageToMarkdown(doc: PmJson): string {
  const blocks = (doc.content ?? []).map(block).filter(b => b.trim() !== '')
  return blocks.length ? blocks.join('\n\n') + '\n' : ''
}

/** Contenu brut d'un fichier .page -> Markdown (vide s'il est illisible). */
export function pageFileToMarkdown(raw: string): string {
  try {
    const doc = parsePageFile(raw)
    return doc ? pageToMarkdown(doc) : ''
  } catch {
    return ''
  }
}
