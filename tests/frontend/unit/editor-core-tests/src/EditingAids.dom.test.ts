// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Aides d'ecriture de Plume : entourer la selection, fermer les crochets,
// renumeroter les listes, rechercher et remplacer, coller, compter les mots,
// retenir la position, plusieurs curseurs, citations en edition.
import { describe, it, expect, beforeEach } from 'vitest'
import { EditorView, runScopeHandlers } from '@codemirror/view'
import { EditorState, EditorSelection, type Extension } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { brackets, highlightSelectionMatches, lineTextStart, listHome, multipleCursors, renumberOrderedLists, selectNextOccurrence, setMultipleCursors, spellcheck } from '../../../../../packages/editor-core/src/EditingAids'
import { findMatches, findNext, findReplace, openFind, replaceAll } from '../../../../../packages/editor-core/src/FindReplace'
import { htmlToMarkdown, smartPaste } from '../../../../../packages/editor-core/src/SmartPaste'
import { countWords, textStats } from '../../../../../packages/editor-core/src/TextStats'
import { notePosition } from '../../../../../packages/editor-core/src/NotePosition'
import { createLivePreviewExtension } from '../../../../../packages/editor-core/src/LivePreview'

function setup(doc: string, selection: EditorSelection | number = doc.length, extra: Extension[] = []) {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: typeof selection === 'number' ? EditorSelection.cursor(selection) : selection,
      extensions: [markdown({ base: markdownLanguage }), spellcheck, brackets, renumberOrderedLists, highlightSelectionMatches, findReplace, ...extra],
    }),
  })
}

/** Ce qu'on tape, comme le ferait le navigateur. */
function type(view: EditorView, text: string) {
  for (const ch of text) {
    const { from, to } = view.state.selection.main
    const done = view.state.facet(EditorView.inputHandler).some(h => h(view, from, to, ch, () => view.state.update({ changes: { from, to, insert: ch } })))
    if (!done) view.dispatch({ changes: { from, to, insert: ch }, selection: { anchor: from + ch.length }, userEvent: 'input.type' })
  }
}

const key = (view: EditorView, k: string) =>
  runScopeHandlers(view, new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }), 'editor')

describe('Entourer la selection, fermer les crochets', () => {
  it('le correcteur orthographique est actif', () => {
    const view = setup('texte')
    expect(view.contentDOM.getAttribute('spellcheck')).toBe('true')
    view.destroy()
  })

  it('* deux fois sur un mot selectionne : **mot**, toujours selectionne', () => {
    const view = setup('un mot ici', EditorSelection.single(3, 6))
    type(view, '**')
    expect(view.state.doc.toString()).toBe('un **mot** ici')
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe('mot')
    type(view, '(')
    expect(view.state.doc.toString()).toBe('un **(mot)** ici')
    view.destroy()
  })

  it('[[ ferme ]], et taper ] passe par-dessus le fermant pose seul', () => {
    const view = setup('voir ')
    type(view, '[[')
    expect(view.state.doc.toString()).toBe('voir [[]]')
    type(view, 'Note]]')
    expect(view.state.doc.toString()).toBe('voir [[Note]]')
    expect(view.state.selection.main.head).toBe(view.state.doc.length)
    view.destroy()
  })

  it('pas de fermant devant un mot ; Retour arriere entre ( et ) efface les deux', () => {
    const view = setup('mot', 0)
    type(view, '(')
    expect(view.state.doc.toString()).toBe('(mot')
    view.dispatch({ changes: { from: 0, to: 1 }, selection: { anchor: 0 } })
    view.dispatch({ changes: { from: 3, insert: ' ' }, selection: { anchor: 4 } })
    type(view, '(')
    expect(view.state.doc.toString()).toBe('mot ()')
    expect(key(view, 'Backspace')).toBe(true)
    expect(view.state.doc.toString()).toBe('mot ')
    view.destroy()
  })

  it('une apostrophe ou un guillemet sans selection ne ferme rien', () => {
    const view = setup('l')
    type(view, '\'"')
    expect(view.state.doc.toString()).toBe('l\'"')
    view.destroy()
  })
})

describe('Listes numerotees', () => {
  const del = (view: EditorView, line: number) => {
    const l = view.state.doc.line(line)
    view.dispatch({ changes: { from: l.from, to: Math.min(l.to + 1, view.state.doc.length) }, userEvent: 'delete.line' })
  }

  it('supprimer un element renumerote la suite, en gardant le depart', () => {
    const view = setup('1. a\n2. b\n3. c\n4. d')
    del(view, 2)
    expect(view.state.doc.toString()).toBe('1. a\n2. c\n3. d')
    del(view, 1)
    expect(view.state.doc.toString()).toBe('1. c\n2. d')
    view.destroy()
  })

  it('une liste qui commence a 5 garde son 5 ; les sous-listes ont leur propre suite', () => {
    const view = setup('5. a\n   1. x\n   2. y\n6. b\n7. c')
    del(view, 4)
    expect(view.state.doc.toString()).toBe('5. a\n   1. x\n   2. y\n6. c')
    view.destroy()
  })

  it('un element colle au milieu prend sa place', () => {
    const view = setup('1. a\n2. b')
    view.dispatch({ changes: { from: 5, insert: '1. nouveau\n' }, userEvent: 'input.paste' })
    expect(view.state.doc.toString()).toBe('1. a\n2. nouveau\n3. b')
    view.destroy()
  })

  it('ni le texte venu d\'ailleurs (synchro), ni le code ne sont renumerotes', () => {
    const view = setup('1. a\n2. b\n3. c')
    view.dispatch({ changes: { from: 5, to: 10 } })
    expect(view.state.doc.toString()).toBe('1. a\n3. c')
    const code = setup('```\n1. a\n2. b\n3. c\n```')
    const l = code.state.doc.line(3)
    code.dispatch({ changes: { from: l.from, to: l.to + 1 }, userEvent: 'delete' })
    expect(code.state.doc.toString()).toBe('```\n1. a\n3. c\n```')
    view.destroy(); code.destroy()
  })
})

describe('Rechercher et remplacer', () => {
  it('trouve, casse ignoree ; expression reguliere en option', () => {
    expect(findMatches('Chat chat CHAT', { text: 'chat', caseSensitive: false, regex: false })).toHaveLength(3)
    expect(findMatches('Chat chat CHAT', { text: 'chat', caseSensitive: true, regex: false })).toHaveLength(1)
    expect(findMatches('a1 b22 c', { text: '\\d+', caseSensitive: false, regex: true }).map(m => [m.from, m.to])).toEqual([[1, 2], [4, 6]])
    expect(findMatches('x', { text: '(', caseSensitive: false, regex: true })).toEqual([])
  })

  it('Ctrl+F ouvre le bandeau avec la selection ; Entree va au suivant ; tout remplacer en une fois', () => {
    const view = setup('un chat, deux chats, trois chats', EditorSelection.single(3, 7))
    openFind(view)
    const panel = view.dom.querySelector('[data-testid="find-panel"]')!
    expect((panel.querySelector('[data-testid="find-input"]') as HTMLInputElement).value).toBe('chat')
    expect(panel.querySelector('[data-testid="find-count"]')!.textContent).toBe('1 sur 3')
    findNext(view)
    expect(view.state.selection.main.from).toBe(14)
    expect(panel.querySelector('[data-testid="find-count"]')!.textContent).toBe('2 sur 3')
    expect(replaceAll(view, 'chien')).toBe(3)
    expect(view.state.doc.toString()).toBe('un chien, deux chiens, trois chiens')
    view.destroy()
  })
})

describe('Occurrences et plusieurs curseurs', () => {
  it('les autres occurrences du texte selectionne sont surlignees', () => {
    const view = setup('mot et mot et MOT', EditorSelection.single(0, 3))
    expect(view.contentDOM.querySelectorAll('.plume-selection-match')).toHaveLength(2)
    view.destroy()
  })

  it('option coupee : une seule selection ; cochee : Ctrl+D ajoute l\'occurrence suivante', async () => {
    const view = setup('mot et mot et mot', EditorSelection.single(0, 3), [multipleCursors])
    view.dispatch({ selection: EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.range(7, 10)]) })
    expect(view.state.selection.ranges).toHaveLength(1)
    view.dispatch({ selection: EditorSelection.single(0, 3) })
    setMultipleCursors(true)
    selectNextOccurrence(view)
    expect(view.state.selection.ranges.map(r => r.from)).toEqual([0, 7])
    setMultipleCursors(false)
    expect(view.state.selection.ranges).toHaveLength(1)
    view.destroy()
  })
})

describe('Coller', () => {
  it('le HTML d\'une page devient du Markdown', () => {
    expect(htmlToMarkdown('<h2>Titre</h2><p>Du <b>gras</b>, de l\'<em>italique</em> et un <a href="https://x.fr">lien</a>.</p>'))
      .toBe('## Titre\n\nDu **gras**, de l\'*italique* et un [lien](https://x.fr).')
    expect(htmlToMarkdown('<ul><li>un<ul><li>deux</li></ul></li><li>trois</li></ul>')).toBe('- un\n  - deux\n- trois')
    expect(htmlToMarkdown('<ol start="3"><li>a</li><li>b</li></ol>')).toBe('3. a\n4. b')
    expect(htmlToMarkdown('<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>')).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |')
    // Google Docs : un <b> qui n'est pas gras, des span en gras.
    expect(htmlToMarkdown('<b style="font-weight:normal"><span style="font-weight:700">fort</span> doux</b>')).toBe('**fort** doux')
    expect(htmlToMarkdown('<pre><code class="language-js">let a = 1\n</code></pre>')).toBe('```js\nlet a = 1\n```')
  })

  it('une adresse collee sur un mot selectionne en fait un lien', () => {
    const view = setup('voir le site', EditorSelection.single(8, 12), [smartPaste])
    const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(event, 'clipboardData', { value: { getData: (t: string) => (t === 'text/plain' ? 'https://savoire.fr' : ''), files: [] } })
    view.contentDOM.dispatchEvent(event)
    expect(view.state.doc.toString()).toBe('voir le [site](https://savoire.fr)')
    view.destroy()
  })
})

describe('Compter les mots', () => {
  it('le texte lu : sans proprietes, sans syntaxe ni adresses', () => {
    const md = '---\ntags: [a, b]\n---\n# Titre\n\n- un **mot** et [un lien](https://exemple.fr/long)\n- [[Note|alias]] l\'été'
    // Titre, un mot et un lien, alias, l'été.
    expect(textStats(md).words).toBe(8)
    expect(countWords('deux mots')).toBe(2)
    expect(textStats('').readingMinutes).toBe(0)
  })
})

describe('Position retenue', () => {
  beforeEach(() => localStorage.clear())

  it('rouverte, la note reprend son curseur, meme si le texte arrive apres', async () => {
    const doc = 'ligne\n'.repeat(50)
    const first = setup(doc, 120, [notePosition('n1')])
    first.dispatch({ selection: { anchor: 130 } })
    await new Promise(r => setTimeout(r, 450))
    first.destroy()
    expect(JSON.parse(localStorage.getItem('plume:pos:n1')!).head).toBe(130)
    const second = setup('', 0, [notePosition('n1')])
    second.dispatch({ changes: { from: 0, insert: doc } })
    await Promise.resolve()
    expect(second.state.selection.main.head).toBe(130)
    second.destroy()
  })
})

describe('Citation en edition', () => {
  it('les > laissent place aux barres, au meme retrait que le rendu', () => {
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const doc = 'avant\n\n> > cite\n\napres'
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc, selection: EditorSelection.cursor(doc.indexOf('cite') + 2), extensions: [markdown({ base: markdownLanguage }), ...createLivePreviewExtension(undefined, undefined, { editorView: null }, false)] }),
    })
    const line = view.contentDOM.querySelector('.plume-quote-live') as HTMLElement
    // Le retrait se mesure dans le navigateur (happy-dom ne lit pas ce style).
    expect(line.textContent).toBe('cite')
    // Le curseur dans les > : ils reviennent.
    view.dispatch({ selection: { anchor: doc.indexOf('> >') + 1 } })
    expect(view.contentDOM.querySelector('.plume-quote-live')).toBeNull()
    view.destroy()
  })
})

describe('Touche Debut', () => {
  const home = (view: EditorView, shiftKey = false) =>
    runScopeHandlers(view, new KeyboardEvent('keydown', { key: 'Home', shiftKey, bubbles: true, cancelable: true }), 'editor')

  it('sur une liste : le debut du texte, puis le debut de la ligne, puis le texte', () => {
    const doc = 'avant\n  - [ ] une tache'
    const view = setup(doc, doc.length, [listHome])
    const text = doc.indexOf('une')
    expect(home(view)).toBe(true)
    expect(view.state.selection.main.head).toBe(text)
    home(view)
    expect(view.state.selection.main.head).toBe(doc.indexOf('  - '))
    home(view)
    expect(view.state.selection.main.head).toBe(text)
    view.destroy()
  })

  it('Maj+Debut selectionne jusqu\'au debut du texte ; une citation aussi', () => {
    const doc = '> > cite ici'
    const view = setup(doc, doc.length, [listHome])
    home(view, true)
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe('cite ici')
    view.destroy()
  })

  it('une ligne ordinaire garde le Debut habituel', () => {
    const view = setup('texte simple', 5, [listHome])
    expect(home(view)).toBe(false)
    view.destroy()
  })
})

describe('Triple clic : la ligne, son texte seulement', () => {
  it('sans la puce, la case, le numero, le > ni les # du titre', () => {
    const at = (t: string) => t.slice(lineTextStart(t))
    expect(at('- [ ] une tache')).toBe('une tache')
    expect(at('  1. un numero')).toBe('un numero')
    expect(at('> > une citation')).toBe('une citation')
    expect(at('## Un titre')).toBe('Un titre')
    expect(at('du texte')).toBe('du texte')
    // Une marque seule : toute la ligne.
    expect(at('- ')).toBe('- ')
  })
})
