// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// FormattingService — all Markdown toggle/insert helpers for EditorCore.
// Operates directly on a CodeMirror EditorView transaction system.
// No React, no plugin-api dependency.

import { EditorView } from '@codemirror/view'
import type { MarkdownFormat } from './types'
import { COLOR_EMOJI_SOURCE, colorOfEmoji, emojiOf, type PlumeColor } from './PlumeMarkdown'

export function toggleMarkdownFormat(view: EditorView, format: MarkdownFormat): void {
  if (format === 'hr') {
    insertHr(view); return
  }
  if (format === 'link') {
    insertLink(view); return
  }
  const headingLevel = ({ h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 } as Record<string, number>)[format]
  if (headingLevel !== undefined) {
    toggleHeading(view, headingLevel); return
  }
  if (format === 'image') {
    insertImage(view); return
  }
  if (format === 'codeblock') {
    insertCodeBlock(view); return
  }
  if (format === 'table') {
    insertTable(view); return
  }
  if (format === 'paragraph') {
    clearBlockFormat(view); return
  }
  if (format === 'ul' || format === 'ol') {
    toggleList(view, format === 'ol'); return
  }
  if (format === 'tasklist') {
    toggleTaskList(view); return
  }
  if (format === 'blockquote') {
    toggleBlockquote(view); return
  }
  if (format === 'highlight') {
    toggleHighlight(view); return
  }
  // Inline markers
  const marker = ({ bold: '**', italic: '*', strike: '~~', code: '`' } as Record<string, string>)[format]
  if (marker) toggleInline(view, marker)
}

function toggleInline(view: EditorView, marker: string): void {
  const { from, to } = view.state.selection.main
  const mLen = marker.length
  const selected = view.state.doc.sliceString(from, to)
  const before   = view.state.doc.sliceString(from - mLen, from)
  const after    = view.state.doc.sliceString(to, to + mLen)

  // Italique dans du gras (**mot**) : les * voisins appartiennent au gras.
  // Un seul * de chaque cote, ou trois, signale l'italique.
  const run = (text: string) => text.length - text.replace(new RegExp(`[${marker}]+$`), '').length
  const runAfter = (text: string) => text.length - text.replace(new RegExp(`^[${marker}]+`), '').length
  const ownsMarker = marker !== '*' || (
    run(view.state.doc.sliceString(Math.max(0, from - 3), from)) % 2 === 1 &&
    runAfter(view.state.doc.sliceString(to, to + 3)) % 2 === 1
  )

  if (before === marker && after === marker && ownsMarker) {
    // Already wrapped — remove markers
    view.dispatch({
      changes: [
        { from: from - mLen, to: from, insert: '' },
        { from: to, to: to + mLen, insert: '' },
      ],
      selection: { anchor: from - mLen, head: to - mLen },
    })
  } else if (selected.length > 0) {
    view.dispatch({
      changes: { from, to, insert: `${marker}${selected}${marker}` },
      selection: { anchor: from + mLen, head: to + mLen },
    })
  } else {
    view.dispatch({
      changes: { from, insert: `${marker}${marker}` },
      selection: { anchor: from + mLen },
    })
  }
  view.focus()
}

function toggleHeading(view: EditorView, level: number): void {
  const { from, to } = view.state.selection.main
  const startLine = view.state.doc.lineAt(from)
  const endLine   = view.state.doc.lineAt(to)
  const changes: { from: number; to: number; insert: string }[] = []

  for (let n = startLine.number; n <= endLine.number; n++) {
    const line   = view.state.doc.line(n)
    const prefix = '#'.repeat(level) + ' '
    const match  = line.text.match(/^(#{1,6}) /)
    if (match) {
      if (match[1].length === level) {
        changes.push({ from: line.from, to: line.from + match[0].length, insert: '' })
      } else {
        changes.push({ from: line.from, to: line.from + match[0].length, insert: prefix })
      }
    } else {
      changes.push({ from: line.from, to: line.from, insert: prefix })
    }
  }
  view.dispatch({ changes })
  view.focus()
}

function toggleList(view: EditorView, ordered: boolean): void {
  const { from, to } = view.state.selection.main
  const startLine = view.state.doc.lineAt(from)
  const endLine   = view.state.doc.lineAt(to)
  const listRe    = /^(\s*)([-*+]|\d+\.)\s/
  const lines: { text: string; from: number }[] = []
  for (let n = startLine.number; n <= endLine.number; n++) {
    const l = view.state.doc.line(n)
    lines.push({ text: l.text, from: l.from })
  }
  const allList = lines.every(l => listRe.test(l.text))
  const changes: { from: number; to: number; insert: string }[] = []

  lines.forEach((l, i) => {
    const match = l.text.match(listRe)
    if (allList && match) {
      changes.push({ from: l.from, to: l.from + match[0].length, insert: match[1] })
    } else if (!allList) {
      const indent = match ? match[1] : ''
      const prefix = ordered ? `${i + 1}. ` : '- '
      if (match) {
        changes.push({ from: l.from, to: l.from + match[0].length, insert: `${indent}${prefix}` })
      } else {
        changes.push({ from: l.from, to: l.from, insert: prefix })
      }
    }
  })
  view.dispatch({ changes })
  view.focus()
}

function toggleBlockquote(view: EditorView): void {
  const { from, to } = view.state.selection.main
  const startLine = view.state.doc.lineAt(from)
  const endLine   = view.state.doc.lineAt(to)
  const bqRe      = /^> ?/
  const changes: { from: number; to: number; insert: string }[] = []

  const allBq = Array.from({ length: endLine.number - startLine.number + 1 }, (_, i) =>
    view.state.doc.line(startLine.number + i).text
  ).every(t => bqRe.test(t))

  for (let n = startLine.number; n <= endLine.number; n++) {
    const line  = view.state.doc.line(n)
    const match = line.text.match(bqRe)
    if (allBq && match) {
      changes.push({ from: line.from, to: line.from + match[0].length, insert: '' })
    } else if (!allBq) {
      changes.push({ from: line.from, to: line.from, insert: '> ' })
    }
  }
  view.dispatch({ changes })
  view.focus()
}

function insertHr(view: EditorView): void {
  const { from } = view.state.selection.main
  const line = view.state.doc.lineAt(from)
  const insert = (line.text.trim() ? '\n\n---\n\n' : '---\n\n')
  view.dispatch({ changes: { from: line.to, insert }, selection: { anchor: line.to + insert.length } })
  view.focus()
}

function insertLink(view: EditorView): void {
  const { from, to } = view.state.selection.main
  const selected = view.state.doc.sliceString(from, to)
  const text     = selected || 'texte'
  const insert   = `[${text}](url)`
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + text.length + 3, head: from + insert.length - 1 },
  })
  view.focus()
}

// ─── Ajouts : liste de taches, bloc de code, tableau, image, paragraphe ──────

/** Bascule « - [ ] » sur les lignes selectionnees. */
function toggleTaskList(view: EditorView): void {
  const { from, to } = view.state.selection.main
  const first = view.state.doc.lineAt(from)
  const last  = view.state.doc.lineAt(to)
  const changes: { from: number; to: number; insert: string }[] = []
  let allTasks = true
  for (let n = first.number; n <= last.number; n++) {
    if (!/^\s*- \[[ xX]\] /.test(view.state.doc.line(n).text)) { allTasks = false; break }
  }
  for (let n = first.number; n <= last.number; n++) {
    const line = view.state.doc.line(n)
    if (allTasks) {
      const m = /^(\s*)- \[[ xX]\] /.exec(line.text)
      if (m) changes.push({ from: line.from, to: line.from + m[0].length, insert: m[1] })
    } else {
      // Repartir d'une puce simple si la ligne en est deja une.
      const m = /^(\s*)(?:- \[[ xX]\] |[-*+] )?/.exec(line.text)
      const indent = m?.[1] ?? ''
      changes.push({ from: line.from, to: line.from + (m?.[0].length ?? 0), insert: `${indent}- [ ] ` })
    }
  }
  view.dispatch({ changes })
  view.focus()
}

/** Retire titre, citation et puce de la ligne : retour au paragraphe. */
function clearBlockFormat(view: EditorView): void {
  const { from, to } = view.state.selection.main
  const first = view.state.doc.lineAt(from)
  const last  = view.state.doc.lineAt(to)
  const changes: { from: number; to: number; insert: string }[] = []
  for (let n = first.number; n <= last.number; n++) {
    const line = view.state.doc.line(n)
    const m = /^(\s*)(#{1,6} |> |- \[[ xX]\] |[-*+] |\d+\. )/.exec(line.text)
    if (m) changes.push({ from: line.from, to: line.from + m[0].length, insert: m[1] })
  }
  if (changes.length) view.dispatch({ changes })
  view.focus()
}

function insertBlock(view: EditorView, block: string, cursorOffset: number): void {
  const { from } = view.state.selection.main
  const line = view.state.doc.lineAt(from)
  const prefix = line.text.trim() ? '\n\n' : ''
  const insert = `${prefix}${block}`
  view.dispatch({
    changes: { from: line.to, insert },
    selection: { anchor: line.to + prefix.length + cursorOffset },
  })
  view.focus()
}

function insertCodeBlock(view: EditorView): void {
  // Curseur sur la ligne vide entre les deux cloture.
  insertBlock(view, '```\n\n```\n', 4)
}

function insertTable(view: EditorView): void {
  insertBlock(view, '| Colonne 1 | Colonne 2 |\n| --- | --- |\n|  |  |\n', 2)
}

function insertImage(view: EditorView): void {
  const { from, to } = view.state.selection.main
  const selected = view.state.doc.sliceString(from, to)
  const alt = selected || 'description'
  const insert = `![${alt}](url)`
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + alt.length + 4, head: from + insert.length - 1 },
  })
  view.focus()
}

// ─── Surlignage et couleur du texte (syntaxe Obsidian, voir PlumeMarkdown) ──

const HL_OPEN_BEFORE = new RegExp(`==(${COLOR_EMOJI_SOURCE})?$`, 'u')
const HL_WRAPPED = new RegExp(`^==(${COLOR_EMOJI_SOURCE})?([\\s\\S]*)==$`, 'u')

/**
 * Surligne la selection (`==texte==`, ou `==🔴texte==` en couleur).
 * Deja surlignee de la meme couleur : le surlignage est retire. D'une autre
 * couleur : la couleur change. Sans selection : insere `====` et place le
 * curseur au milieu.
 */
export function toggleHighlight(view: EditorView, color?: PlumeColor): void {
  const { state } = view
  const { from, to } = state.selection.main
  const open = `==${color ? emojiOf(color) : ''}`
  const selected = state.doc.sliceString(from, to)

  // La selection englobe les marqueurs : ==🔴texte==
  const whole = HL_WRAPPED.exec(selected)
  if (whole && selected.length >= 4) {
    const current = whole[1] ? colorOfEmoji(whole[1]) : undefined
    const inner = whole[2]
    const insert = current === color ? inner : `${open}${inner}==`
    view.dispatch({ changes: { from, to, insert }, selection: { anchor: from, head: from + insert.length } })
    view.focus()
    return
  }

  // Les marqueurs entourent la selection : ==🔴[texte]==
  const lineStart = state.doc.lineAt(from).from
  const before = HL_OPEN_BEFORE.exec(state.doc.sliceString(Math.max(lineStart, from - 4), from))
  const after = state.doc.sliceString(to, to + 2) === '=='
  if (before && after) {
    const current = before[1] ? colorOfEmoji(before[1]) : undefined
    const openFrom = from - before[0].length
    if (current === color) {
      view.dispatch({
        changes: [{ from: openFrom, to: from, insert: '' }, { from: to, to: to + 2, insert: '' }],
        selection: { anchor: openFrom, head: openFrom + (to - from) },
      })
    } else {
      const shift = open.length - before[0].length
      view.dispatch({
        changes: { from: openFrom, to: from, insert: open },
        selection: { anchor: from + shift, head: to + shift },
      })
    }
    view.focus()
    return
  }

  view.dispatch({
    changes: { from, to, insert: `${open}${selected}==` },
    selection: { anchor: from + open.length, head: to + open.length },
  })
  view.focus()
}

// Debut structurel d'une ligne : indentation, citations, puce / numero /
// case a cocher, ou titre. La couleur se place juste apres.
const LINE_PREFIX_RE = /^(\s*(?:>\s?)*(?:#{1,6}\s+|(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)?)/
const LINE_COLOR_RE = new RegExp(`^\`(${COLOR_EMOJI_SOURCE})\` ?`, 'u')

/** Couleur de texte d'une ligne, et ou se trouve son marqueur. */
export function lineColorOf(text: string): { color: PlumeColor; from: number; to: number } | null {
  const prefix = LINE_PREFIX_RE.exec(text)?.[1] ?? ''
  const m = LINE_COLOR_RE.exec(text.slice(prefix.length))
  if (!m) return null
  return { color: colorOfEmoji(m[1])!, from: prefix.length, to: prefix.length + m[0].length }
}

/**
 * Colore les lignes selectionnees : `🔴` en debut de ligne (apres la puce,
 * le # ou le >). Si toutes ont deja cette couleur, elle est retiree ;
 * null retire la couleur. Les lignes vides sont laissees.
 */
export function setLineColor(view: EditorView, color: PlumeColor | null): void {
  const { state } = view
  const { from, to } = state.selection.main
  const first = state.doc.lineAt(from).number
  const last = state.doc.lineAt(to).number
  const lines = []
  for (let n = first; n <= last; n++) {
    const line = state.doc.line(n)
    if (line.text.trim()) lines.push(line)
  }
  if (lines.length === 0 && first === last) lines.push(state.doc.line(first))
  const target = color && lines.every(l => lineColorOf(l.text)?.color === color) ? null : color
  const changes: { from: number; to: number; insert: string }[] = []
  for (const line of lines) {
    const current = lineColorOf(line.text)
    const insert = target ? `\`${emojiOf(target)}\` ` : ''
    if (current) changes.push({ from: line.from + current.from, to: line.from + current.to, insert })
    else if (target) {
      const at = line.from + (LINE_PREFIX_RE.exec(line.text)?.[1].length ?? 0)
      changes.push({ from: at, to: at, insert })
    }
  }
  if (changes.length) view.dispatch({ changes })
  view.focus()
}

// ─── Autres actions (commandes du moteur de raccourcis) ──────────────────────

/**
 * Coche ou decoche la case des lignes selectionnees (comme Ctrl+Entree dans
 * Obsidian). Une ligne sans case en recoit une.
 */
export function toggleChecklistStatus(view: EditorView): void {
  const { state } = view
  const { from, to } = state.selection.main
  const changes: { from: number; to: number; insert: string }[] = []
  for (let n = state.doc.lineAt(from).number; n <= state.doc.lineAt(to).number; n++) {
    const line = state.doc.line(n)
    const box = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]/.exec(line.text)
    if (box) {
      const at = line.from + box[1].length + 1
      changes.push({ from: at, to: at + 1, insert: box[2] === ' ' ? 'x' : ' ' })
      continue
    }
    const item = /^(\s*(?:[-*+]|\d+[.)])\s+)/.exec(line.text)
    const at = line.from + (item ? item[1].length : (/^\s*/.exec(line.text)?.[0].length ?? 0))
    changes.push({ from: at, to: at, insert: item ? '[ ] ' : '- [ ] ' })
  }
  view.dispatch({ changes })
  view.focus()
}

const INLINE_MARKS_RE = new RegExp(`\\*\\*|__|~~|==(?:${COLOR_EMOJI_SOURCE})?|(?<![\\w*])[*_](?![\\s*])|(?<![\\s*])[*_](?![\\w*])|\``, 'gu')

/** Retire gras, italique, barre, surlignage et code de la selection. */
export function clearInlineFormatting(view: EditorView): void {
  const { from, to } = view.state.selection.main
  if (from === to) { view.focus(); return }
  const text = view.state.doc.sliceString(from, to)
  const insert = text.replace(INLINE_MARKS_RE, '')
  view.dispatch({ changes: { from, to, insert }, selection: { anchor: from, head: from + insert.length } })
  view.focus()
}

/**
 * Entoure la selection de `before` et `after` ; sans selection, place le
 * curseur entre les deux ([[ ]], ![[ ]]...).
 */
export function wrapSelection(view: EditorView, before: string, after: string): void {
  const { from, to } = view.state.selection.main
  const selected = view.state.doc.sliceString(from, to)
  view.dispatch({
    changes: { from, to, insert: `${before}${selected}${after}` },
    selection: { anchor: from + before.length, head: from + before.length + selected.length },
  })
  view.focus()
}

/** Insere un callout sous la ligne courante, curseur sur son titre. */
export function insertCallout(view: EditorView, kind = 'note'): void {
  const { from } = view.state.selection.main
  const line = view.state.doc.lineAt(from)
  const prefix = line.text.trim() ? '\n\n' : ''
  const head = `> [!${kind}] `
  const insert = `${prefix}${head}\n> `
  const at = line.text.trim() ? line.to : line.from
  view.dispatch({
    changes: { from: at, to: line.text.trim() ? at : line.to, insert },
    selection: { anchor: at + prefix.length + head.length },
  })
  view.focus()
}
