// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Module liste : Alt+↑ / Alt+↓ deplace un element avec ses sous-elements.
import { describe, it, expect } from 'vitest'
import { moveListItem, type ListEditor } from '../../../../packages/plugins/plugin-task-list/src/moveItem'

/** Un editeur minimal sur un texte. */
function editor(text: string, cursor: number) {
  const ed = {
    text, anchor: cursor, head: cursor,
    get state() {
      const lines = ed.text.split('\n')
      const starts: number[] = []
      let at = 0
      for (const l of lines) { starts.push(at); at += l.length + 1 }
      const line = (n: number) => ({ from: starts[n - 1], to: starts[n - 1] + lines[n - 1].length, text: lines[n - 1], number: n })
      return {
        doc: {
          lines: lines.length,
          line,
          lineAt: (pos: number) => { let n = 1; while (n < lines.length && starts[n] <= pos) n++; return line(n) },
          sliceString: (from: number, to: number) => ed.text.slice(from, to),
        },
        selection: { main: { anchor: ed.anchor, head: ed.head, from: Math.min(ed.anchor, ed.head), to: Math.max(ed.anchor, ed.head) } },
      }
    },
    dispatch(spec: Parameters<ListEditor['dispatch']>[0]) {
      const c = spec.changes
      ed.text = ed.text.slice(0, c.from) + c.insert + ed.text.slice(c.to)
      ed.anchor = spec.selection.anchor
      ed.head = spec.selection.head
    },
  }
  return ed
}

const DOC = '- a\n  - a1\n  - a2\n- b\n  - b1\n- c'

describe('plugin-task-list — deplacer un element', () => {
  it('Alt+↓ : « a » et ses enfants passent sous « b » et les siens', () => {
    const ed = editor(DOC, 2)
    expect(moveListItem(ed, 1)).toBe(true)
    expect(ed.text).toBe('- b\n  - b1\n- a\n  - a1\n  - a2\n- c')
    // Le curseur suit l'element.
    expect(ed.text.slice(ed.head - 2, ed.head + 1)).toBe('- a')
  })

  it('Alt+↑ : « c » passe au-dessus de « b » et de ses enfants', () => {
    const ed = editor(DOC, DOC.indexOf('- c') + 2)
    moveListItem(ed, -1)
    expect(ed.text).toBe('- a\n  - a1\n  - a2\n- c\n- b\n  - b1')
  })

  it('un sous-element reste parmi ses freres ; sans frere, il passe la ligne d\'a cote', () => {
    const ed = editor(DOC, DOC.indexOf('a2'))
    moveListItem(ed, -1)
    expect(ed.text).toBe('- a\n  - a2\n  - a1\n- b\n  - b1\n- c')
    const solo = editor('Titre\n- seul\n  - enfant', 'Titre\n- '.length)
    moveListItem(solo, -1)
    expect(solo.text).toBe('- seul\n  - enfant\nTitre')
  })

  it('hors d\'une liste : rien, la touche revient a l\'editeur', () => {
    const ed = editor('texte\n- a', 1)
    expect(moveListItem(ed, 1)).toBe(false)
  })
})
