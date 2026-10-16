// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Surlignage et couleur du texte, compatibles Obsidian : rendu Markdown et
// commandes de mise en forme.
import { describe, it, expect } from 'vitest'
import { marked } from 'marked'
import { EditorState, EditorSelection } from '@codemirror/state'
import '../../../../../packages/editor-core/src/PlumeMarkdown'
import { toggleHighlight, setLineColor, lineColorOf } from '../../../../../packages/editor-core/src/FormattingService'

const html = (md: string) => (marked.parse(md, { breaks: true }) as string).trim()

describe('Surlignage ==texte==', () => {
  it('sans couleur : <mark> du theme', () => {
    expect(html('un ==mot== ici')).toBe('<p>un <mark class="plume-hl">mot</mark> ici</p>')
  })

  it('emoji juste apres == : la couleur, sans l\'emoji', () => {
    expect(html('==🔴Important==')).toBe('<p><mark class="plume-hl plume-hl-red">Important</mark></p>')
    expect(html('==🟣a **b**==')).toBe('<p><mark class="plume-hl plume-hl-purple">a <strong>b</strong></mark></p>')
  })

  it('un autre emoji reste du texte', () => {
    expect(html('==🍕pizza==')).toBe('<p><mark class="plume-hl">🍕pizza</mark></p>')
  })

  it('pas de surlignage dans le code ni pour == isole', () => {
    expect(html('`==a==`')).toBe('<p><code>==a==</code></p>')
    expect(html('a == b')).toBe('<p>a == b</p>')
  })
})

describe('Couleur du texte : `🔴` en debut de ligne', () => {
  it('colore la ligne, sans afficher le marqueur', () => {
    expect(html('`🔵` Une ligne bleue')).toBe('<p><span class="plume-color plume-color-blue">Une ligne bleue</span></p>')
  })

  it('seulement la ligne qui le porte', () => {
    expect(html('normale\n`🔴` rouge\nnormale')).toBe(
      '<p>normale<br><span class="plume-color plume-color-red">rouge</span><br>normale</p>',
    )
  })

  it('apres une puce ou un titre', () => {
    expect(html('- `🟢` fait')).toContain('<li><span class="plume-color plume-color-green">fait</span></li>')
    expect(html('## `🟠` Titre')).toContain('<span class="plume-color plume-color-orange">Titre</span>')
  })

  it('au milieu d\'une ligne, c\'est du code ordinaire', () => {
    expect(html('voir `🔴` ici')).toBe('<p>voir <code>🔴</code> ici</p>')
  })
})

// Vue minimale : FormattingService ne se sert que de state, dispatch et focus.
function view(doc: string, from: number, to = from) {
  const v = {
    state: EditorState.create({ doc, selection: EditorSelection.single(from, to) }),
    dispatch(spec: Parameters<EditorState['update']>[0]) { v.state = v.state.update(spec).state },
    focus() {},
  }
  return v as unknown as import('@codemirror/view').EditorView & { state: EditorState }
}
const sel = (v: { state: EditorState }) => v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to)

describe('toggleHighlight', () => {
  it('entoure la selection, et la retire au second appel', () => {
    const v = view('un mot ici', 3, 6)
    toggleHighlight(v)
    expect(v.state.doc.toString()).toBe('un ==mot== ici')
    expect(sel(v)).toBe('mot')
    toggleHighlight(v)
    expect(v.state.doc.toString()).toBe('un mot ici')
  })

  it('change de couleur sans empiler les marqueurs', () => {
    const v = view('un mot ici', 3, 6)
    toggleHighlight(v, 'red')
    expect(v.state.doc.toString()).toBe('un ==🔴mot== ici')
    toggleHighlight(v, 'blue')
    expect(v.state.doc.toString()).toBe('un ==🔵mot== ici')
    expect(sel(v)).toBe('mot')
    toggleHighlight(v, 'blue')
    expect(v.state.doc.toString()).toBe('un mot ici')
  })

  it('selection qui englobe les marqueurs', () => {
    const v = view('==🟡mot==', 0, '==🟡mot=='.length)
    toggleHighlight(v, 'yellow')
    expect(v.state.doc.toString()).toBe('mot')
  })
})

describe('setLineColor', () => {
  it('ajoute la couleur apres la puce, la change, puis la retire', () => {
    const v = view('- tache', 3)
    setLineColor(v, 'red')
    expect(v.state.doc.toString()).toBe('- `🔴` tache')
    setLineColor(v, 'green')
    expect(v.state.doc.toString()).toBe('- `🟢` tache')
    setLineColor(v, 'green')
    expect(v.state.doc.toString()).toBe('- tache')
  })

  it('toutes les lignes selectionnees, sauf les vides', () => {
    const doc = '# Titre\n\n> cite'
    const v = view(doc, 0, doc.length)
    setLineColor(v, 'blue')
    expect(v.state.doc.toString()).toBe('# `🔵` Titre\n\n> `🔵` cite')
    setLineColor(v, null)
    expect(v.state.doc.toString()).toBe(doc)
  })

  it('lineColorOf ignore un emoji ordinaire', () => {
    expect(lineColorOf('🔴 urgent')).toBeNull()
    expect(lineColorOf('- [ ] `🟣` tache')?.color).toBe('purple')
  })
})

describe('Gras puis italique', () => {
  it('Ctrl+I dans du gras ajoute l\'italique au lieu de defaire le gras', async () => {
    const { toggleMarkdownFormat } = await import('../../../../../packages/editor-core/src/FormattingService')
    const v = view('**mot**', 2, 5)
    toggleMarkdownFormat(v, 'italic')
    expect(v.state.doc.toString()).toBe('***mot***')
    toggleMarkdownFormat(v, 'italic')
    expect(v.state.doc.toString()).toBe('**mot**')
  })
})
