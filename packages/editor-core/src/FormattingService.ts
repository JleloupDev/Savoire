// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// FormattingService — all Markdown toggle/insert helpers for EditorCore.
// Operates directly on a CodeMirror EditorView transaction system.
// No React, no plugin-api dependency.

import { EditorView } from '@codemirror/view'
import type { MarkdownFormat } from './types'

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

  if (before === marker && after === marker) {
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
