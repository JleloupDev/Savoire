// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Alt+↑ / Alt+↓ sur un element de liste : il monte ou descend avec ses
// sous-elements, par-dessus l'element voisin (lui aussi avec les siens),
// comme dans Obsidian. Sans voisin, il passe la ligne d'a cote.

/** Ce qu'il faut d'un editeur CodeMirror (le plugin ne depend pas de CodeMirror). */
export interface ListEditor {
  state: {
    doc: {
      lines: number
      line(n: number): { from: number; to: number; text: string; number: number }
      lineAt(pos: number): { from: number; to: number; text: string; number: number }
      sliceString(from: number, to: number): string
    }
    selection: { main: { anchor: number; head: number; from: number; to: number } }
    readOnly?: boolean
  }
  dispatch(spec: { changes: { from: number; to: number; insert: string }; selection: { anchor: number; head: number }; scrollIntoView: boolean; userEvent: string }): void
}

const ITEM_RE = /^(\s*)([-*+]|\d+[.)])\s/

const indentOf = (text: string) => text.length - text.trimStart().length

/** Les lignes [debut, fin] de l'element qui commence a la ligne `n`, sous-elements compris. */
function itemBlock(ed: ListEditor, n: number): [number, number] {
  const doc = ed.state.doc
  const base = indentOf(doc.line(n).text)
  let end = n
  for (let k = n + 1; k <= doc.lines; k++) {
    const text = doc.line(k).text
    if (!text.trim()) {
      // Une ligne vide reste dans l'element si la suite est encore dedans.
      let next = k + 1
      while (next <= doc.lines && !doc.line(next).text.trim()) next++
      if (next <= doc.lines && indentOf(doc.line(next).text) > base) continue
      break
    }
    if (indentOf(text) <= base) break
    end = k
  }
  return [n, end]
}

/** La ligne de l'element de liste ou se trouve le curseur, ou null. */
export function itemLineAt(ed: ListEditor): number | null {
  const doc = ed.state.doc
  const { from, to } = ed.state.selection.main
  const line = doc.lineAt(from)
  if (!ITEM_RE.test(line.text)) return null
  // Une selection qui deborde de l'element : le deplacement ligne a ligne s'en charge.
  const [, end] = itemBlock(ed, line.number)
  return doc.lineAt(to).number <= end ? line.number : null
}

/** L'element voisin de meme niveau, au-dessus (-1) ou au-dessous (1). */
function sibling(ed: ListEditor, n: number, end: number, dir: 1 | -1): [number, number] | null {
  const doc = ed.state.doc
  const base = indentOf(doc.line(n).text)
  if (dir === 1) {
    let k = end + 1
    while (k <= doc.lines && !doc.line(k).text.trim()) k++
    if (k > doc.lines) return null
    const text = doc.line(k).text
    return ITEM_RE.test(text) && indentOf(text) === base ? itemBlock(ed, k) : null
  }
  for (let k = n - 1; k >= 1; k--) {
    const text = doc.line(k).text
    if (!text.trim()) continue
    const indent = indentOf(text)
    if (indent > base) continue
    return indent === base && ITEM_RE.test(text) ? itemBlock(ed, k) : null
  }
  return null
}

/** Deplace l'element du curseur. Faux si le curseur n'est pas sur un element. */
export function moveListItem(ed: ListEditor, dir: 1 | -1): boolean {
  if (ed.state.readOnly) return false
  const n = itemLineAt(ed)
  if (n === null) return false
  const doc = ed.state.doc
  const [start, end] = itemBlock(ed, n)
  // Le voisin, ou a defaut la ligne d'a cote.
  const other = sibling(ed, start, end, dir)
    ?? (dir === -1 ? (start > 1 ? [start - 1, start - 1] as [number, number] : null) : (end < doc.lines ? [end + 1, end + 1] as [number, number] : null))
  if (!other) return true
  const [a, b] = dir === -1 ? [other, [start, end] as [number, number]] : [[start, end] as [number, number], other]
  const from = doc.line(a[0]).from
  const to = doc.line(b[1]).to
  const textA = doc.sliceString(from, doc.line(a[1]).to)
  const between = doc.sliceString(doc.line(a[1]).to, doc.line(b[0]).from)
  const textB = doc.sliceString(doc.line(b[0]).from, to)
  const insert = textB + between + textA
  // Le curseur suit l'element deplace.
  const shift = dir === -1 ? -(textA.length + between.length) : textB.length + between.length
  const { anchor, head } = ed.state.selection.main
  ed.dispatch({
    changes: { from, to, insert },
    selection: { anchor: anchor + shift, head: head + shift },
    scrollIntoView: true,
    userEvent: 'move.line',
  })
  return true
}
