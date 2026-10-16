// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Plugin Plans : la vue CodeMirror branchee sur un texte partage (ISharedText),
// avec deux textes en memoire relies comme deux membres d'un vault.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommandRegistryImpl, HotkeyManager, InMemorySharedText } from '@savoire/plugin-runtime'
import { OutlineEditor, outlineActions, outlineCommands } from '@savoire/plugin-outline'

const editors: OutlineEditor[] = []

function editor(text?: InMemorySharedText, readOnly = false): OutlineEditor {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  const ed = new OutlineEditor({ parent, text, readOnly })
  editors.push(ed)
  return ed
}

/** Deux membres : deux textes relies, une vue chacun. */
function pair(initial: string) {
  const a = new InMemorySharedText(initial)
  const b = new InMemorySharedText(initial)
  InMemorySharedText.link(a, b)
  return { a, b, va: editor(a), vb: editor(b) }
}

afterEach(() => {
  while (editors.length) editors.pop()!.destroy()
  document.body.replaceChildren()
})

describe('plugin-outline — liaison CodeMirror <-> ISharedText', () => {
  it('ce qu\'ecrit une vue apparait dans l\'autre, sans boucle', () => {
    const { a, b, va, vb } = pair('- un\n- deux')
    const sentA = vi.fn()
    const sentB = vi.fn()
    a.onChange((_d, origin) => { if (origin === 'local') sentA() })
    b.onChange((_d, origin) => { if (origin === 'local') sentB() })

    va.view.dispatch({ changes: { from: 4, insert: ' et demi' } })

    expect(a.toString()).toBe('- un et demi\n- deux')
    expect(b.toString()).toBe('- un et demi\n- deux')
    expect(vb.view.state.doc.toString()).toBe('- un et demi\n- deux')
    // Une seule ecriture locale, et la vue B n'a rien renvoye.
    expect(sentA).toHaveBeenCalledTimes(1)
    expect(sentB).not.toHaveBeenCalled()

    vb.view.dispatch({ changes: { from: vb.view.state.doc.length, insert: '\n- trois' } })
    expect(va.view.state.doc.toString()).toBe('- un et demi\n- deux\n- trois')
    expect(sentA).toHaveBeenCalledTimes(1)
    expect(sentB).toHaveBeenCalledTimes(1)
  })

  it('le contenu initial arrive en deltas distants apres ouverture', () => {
    const a = new InMemorySharedText('')
    const remote = new InMemorySharedText('')
    InMemorySharedText.link(a, remote)
    const ed = editor(a)
    expect(ed.view.state.doc.toString()).toBe('')
    remote.insert(0, '- a\n  - b')
    expect(ed.view.state.doc.toString()).toBe('- a\n  - b')
  })

  it('une operation d\'arbre part comme un changement minimal', () => {
    const { b, va } = pair('- a\n- b\n  - c')
    const deltas: unknown[] = []
    b.onChange(d => deltas.push(d))
    va.view.dispatch({ selection: { anchor: 7 } })
    outlineActions.indent.run(va.view)
    expect(b.toString()).toBe('- a\n  - b\n    - c')
    expect(deltas).toEqual([[{ retain: 4 }, { insert: '  ' }, { retain: 6 }, { insert: '  ' }]])
  })

  it('l\'annulation ne defait pas les changements distants', () => {
    const { va, vb } = pair('- a')
    va.view.dispatch({ changes: { from: 3, insert: 'b' }, userEvent: 'input' })
    vb.view.dispatch({ changes: { from: 0, insert: '- z\n' }, userEvent: 'input' })
    expect(va.view.state.doc.toString()).toBe('- z\n- ab')
  })

  it('lecture seule : pas d\'operation d\'arbre', () => {
    const a = new InMemorySharedText('- a\n- b')
    const ed = editor(a, true)
    ed.view.dispatch({ selection: { anchor: 7 } })
    expect(outlineActions.indent.available(ed.view)).toBe(false)
    ed.setReadOnly(false)
    expect(outlineActions.indent.available(ed.view)).toBe(true)
    outlineActions.indent.run(ed.view)
    expect(a.toString()).toBe('- a\n  - b')
  })

  it('sans texte partage, la vue reste en lecture seule', () => {
    const ed = editor(undefined)
    ed.setContent('- a')
    ed.setReadOnly(false)
    expect(ed.view.state.readOnly).toBe(true)
    expect(ed.view.state.doc.toString()).toBe('- a')
  })
})

describe('plugin-outline — pliage et zoom (locaux a la vue)', () => {
  it('plier masque les enfants sans toucher au texte', () => {
    const { a, va, vb } = pair('- a\n  - b\n  - c\n- d')
    va.toggleFold(0, true)
    expect(va.hiddenLines()).toEqual([1, 2])
    expect(vb.hiddenLines()).toEqual([])
    expect(a.toString()).toBe('- a\n  - b\n  - c\n- d')
    va.toggleFold(0, false)
    expect(va.hiddenLines()).toEqual([])
  })

  it('zoomer n\'affiche que le sous-arbre, et suit les modifications distantes', () => {
    const { va, vb } = pair('- a\n- b\n  - c\n- d')
    va.zoomTo(4)
    expect(va.hiddenLines()).toEqual([0, 3])
    // L'element zoome est le titre ; le fil d'Ariane mene a la racine.
    expect(va.view.dom.querySelector('.cm-outline-title')!.textContent).toBe('b')
    expect(va.dom.querySelector('[data-testid="outline-breadcrumbs"]')!.textContent).toBe('Plan')
    vb.view.dispatch({ changes: { from: 0, insert: '- avant\n' } })
    expect(va.zoom).toBe(12)
    expect(va.hiddenLines()).toEqual([0, 1, 4])
    va.zoomTo(null)
    expect(va.hiddenLines()).toEqual([])
  })

  it('Ctrl+A : l\'element, puis le sous-arbre zoome', () => {
    const { va } = pair('- a\n- b\n  - c\n- d')
    va.zoomTo(4)
    va.view.dispatch({ selection: { anchor: 13 } })
    outlineActions.selectItem.run(va.view)
    const s1 = va.view.state.selection.main
    expect(va.view.state.sliceDoc(s1.from, s1.to)).toBe('c')
    outlineActions.selectItem.run(va.view)
    const s2 = va.view.state.selection.main
    expect(va.view.state.sliceDoc(s2.from, s2.to)).toBe('b\n  - c')
  })

  it('deplacer un element plie garde le pliage', () => {
    const { a, va } = pair('- a\n- b\n  - c')
    va.view.dispatch({ selection: { anchor: 6 } })
    va.toggleFold(4, true)
    outlineActions.moveUp.run(va.view)
    expect(a.toString()).toBe('- b\n  - c\n- a')
    expect(va.hiddenLines()).toEqual([1])
  })
})

describe('plugin-outline — touches par le moteur de raccourcis', () => {
  /** Moteur avec les commandes du plan, et une touche simulee. */
  function engine() {
    const registry = new CommandRegistryImpl()
    for (const c of outlineCommands()) registry.register(c)
    const hotkeys = new HotkeyManager(registry, 'other')
    const press = (key: string, mods: { shift?: boolean; ctrl?: boolean; alt?: boolean } = {}) => {
      let prevented = false
      const handled = hotkeys.handleKeyEvent({
        key, code: '', ctrlKey: !!mods.ctrl, metaKey: false, shiftKey: !!mods.shift, altKey: !!mods.alt,
        get defaultPrevented() { return prevented },
        preventDefault() { prevented = true },
      }, { editorView: null })
      return handled
    }
    return { hotkeys, press }
  }

  function focusedEditor(doc: string, cursor: number) {
    const ed = editor(new InMemorySharedText(doc))
    ed.view.focus()
    ed.view.dispatch({ selection: { anchor: cursor } })
    return ed
  }

  it('aucune commande sans plan qui a le focus', () => {
    const { press } = engine()
    editor(new InMemorySharedText('- a'))
    expect(press('Enter')).toBe(false)
    expect(press('Tab')).toBe(false)
  })

  it('Entree, Tab, Maj+Tab passent par les commandes', () => {
    const { press } = engine()
    const ed = focusedEditor('- a\n- b', 7)
    expect(ed.view.hasFocus).toBe(true)
    expect(press('Tab')).toBe(true)
    expect(ed.view.state.doc.toString()).toBe('- a\n  - b')
    expect(press('Enter')).toBe(true)
    expect(ed.view.state.doc.toString()).toBe('- a\n  - b\n  - ')
    expect(press('Tab', { shift: true })).toBe(true)
    expect(ed.view.state.doc.toString()).toBe('- a\n  - b\n- ')
  })

  it('Retour arriere : commande au debut d\'un element, frappe normale ailleurs', () => {
    const { press } = engine()
    const ed = focusedEditor('- a\n- bc', 8)
    expect(press('Backspace')).toBe(false)
    ed.view.dispatch({ selection: { anchor: 6 } })
    expect(press('Backspace')).toBe(true)
    expect(ed.view.state.doc.toString()).toBe('- abc')
  })

  it('Maj+Entree ajoute une note sous l\'element', () => {
    const { press } = engine()
    const ed = focusedEditor('- a\n  - b', 3)
    expect(press('Enter', { shift: true })).toBe(true)
    expect(ed.view.state.doc.toString()).toBe('- a\n  \n  - b')
  })

  it('Echap remonte d\'un niveau, seulement quand on est entre dans un element', () => {
    const { press } = engine()
    const ed = focusedEditor('- a\n  - b\n    - c', 9)
    expect(press('Escape')).toBe(false)
    expect(press('.', { ctrl: true })).toBe(true)
    expect(ed.zoom).toBe(4)
    expect(ed.dom.querySelector('[data-testid="outline-breadcrumbs"]')!.textContent).toContain('a')
    expect(press('Escape')).toBe(true)
    expect(ed.zoom).toBe(0)
    expect(press('Escape')).toBe(true)
    expect(ed.zoom).toBeNull()
    expect(ed.dom.querySelector('[data-testid="outline-page-title"]')).not.toBeNull()
  })

  it('l\'element zoome devient le titre : Entree y cree un enfant', () => {
    const { press } = engine()
    const ed = focusedEditor('- a\n- b', 3)
    ed.zoomTo(0)
    ed.view.dispatch({ selection: { anchor: 3 } })
    expect(ed.view.dom.querySelector('.cm-outline-title')!.textContent).toBe('a')
    expect(press('Enter')).toBe(true)
    expect(ed.view.state.doc.toString()).toBe('- a\n  - \n- b')
  })
})
