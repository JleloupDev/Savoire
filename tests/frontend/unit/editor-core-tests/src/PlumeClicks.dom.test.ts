// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Plume : un clic ne fait pas bouger la note (la ligne visee s'ouvre avant
// que CodeMirror ne place le curseur, le bloc quitte reste ouvert jusqu'au
// relachement), le corps d'un callout est rendu en Markdown, et le clic
// droit « Retirer le ... » garde le contenu d'un bloc sans son cadre.
import { describe, it, expect } from 'vitest'
import { EditorView } from '@codemirror/view'
import { EditorState, EditorSelection } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { createLivePreviewExtension, type PreviewMode } from '../../../../../packages/editor-core/src/LivePreview'
import { renderFragmentInto } from '../../../../../packages/editor-core/src/NoteFragment'
import calloutPlugin from '../../../../../packages/plugins/plugin-callout/src/index'
import type { BlockRegistry, BlockSpec, PluginAPI } from '@savoire/plugin-api'

function registryOf(...specs: BlockSpec[]): BlockRegistry {
  const match = (text: string) => specs.find(s => (typeof s.detect === 'function' ? s.detect(text) : !!s.detect?.test(text)))
  return {
    register: () => {}, unregister: () => {}, getAll: () => specs,
    detectBlock: text => { const spec = match(text); return spec ? { type: spec.type, spec } : null },
  }
}

async function calloutSpec(): Promise<BlockSpec> {
  let spec: BlockSpec | null = null
  const api = { triggers: { register: () => {} }, blocks: { register: (s: BlockSpec) => { spec = s } } } as unknown as PluginAPI
  await calloutPlugin.onload(api)
  return spec!
}

function setup(doc: string, cursor: number, mode: PreviewMode = 'power', registry?: BlockRegistry) {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(cursor),
      extensions: [markdown({ base: markdownLanguage }), ...createLivePreviewExtension(registry, undefined, { editorView: null }, false, undefined, mode)],
    }),
  })
}

const mouse = (type: string, target: Element, button = 0) =>
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button, buttons: type === 'mouseup' ? 0 : 1 }))

describe('Un clic ne fait pas bouger la note', () => {
  const DOC = 'intro\n\n```js\nconst a = 1\n```\n\n# Grand titre\n\nfin'

  it('la ligne visee s\'ouvre au moment de l\'appui, le bloc quitte reste ouvert jusqu\'apres le relachement', async () => {
    const view = setup(DOC, DOC.indexOf('const'))
    // Le curseur est dans le code : il est en texte brut, le titre est rendu.
    expect(view.contentDOM.querySelector('pre')).toBeNull()
    const heading = view.contentDOM.querySelector('.vault-rendered-block h1')!
    expect(heading.textContent).toBe('Grand titre')

    mouse('mousedown', heading)
    // CodeMirror pose le curseur sur le titre.
    view.dispatch({ selection: EditorSelection.cursor(DOC.indexOf('Grand')) })
    const rawLines = () => Array.from(view.contentDOM.querySelectorAll('.cm-line')).map(l => l.textContent)
    expect(rawLines()).toContain('# Grand titre')
    // Le code ne se referme pas sous la souris : rien ne glisse.
    expect(rawLines()).toContain('const a = 1')
    expect(view.contentDOM.querySelector('pre')).toBeNull()

    mouse('mouseup', view.contentDOM)
    expect(view.contentDOM.querySelector('pre')).toBeNull()
    // Passe le temps d'un double clic : le code se referme.
    await new Promise(r => setTimeout(r, 600))
    expect(view.contentDOM.querySelector('pre')).not.toBeNull()
    expect(rawLines()).toContain('# Grand titre')
    view.destroy()
  })

  it('le clic droit n\'ouvre rien', () => {
    const view = setup(DOC, DOC.length)
    const heading = view.contentDOM.querySelector('.vault-rendered-block h1')!
    mouse('mousedown', heading, 2)
    expect(view.contentDOM.querySelector('.vault-rendered-block h1')).not.toBeNull()
    view.destroy()
  })
})

describe('Corps d\'un callout', () => {
  it('rendu en Markdown : gras, liste, tableau', async () => {
    const spec = await calloutSpec()
    const root = document.createElement('div')
    renderFragmentInto(root, '> [!NOTE]\n> Du **gras**\n> - un\n> - deux\n>\n> | a | b |\n> |---|---|\n> | 1 | 2 |', { registry: registryOf(spec) })
    const body = root.querySelector('.callout-body')!
    expect(body.querySelector('strong')?.textContent).toBe('gras')
    expect(body.querySelectorAll('li')).toHaveLength(2)
    expect(body.querySelector('table')).not.toBeNull()
  })

  it('sans rendu offert par l\'editeur : le texte tel quel', async () => {
    const spec = await calloutSpec()
    const el = spec.renderClient(spec.deserialize('> [!NOTE]\n> Du **gras**'), { editorView: null })
    expect(el.querySelector('.callout-body')!.textContent).toBe('Du **gras**')
  })
})

describe('Retirer un bloc (clic droit, mode classique)', () => {
  const retirer = (view: EditorView, selector: string): string[] => {
    view.contentDOM.querySelector(selector)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    const menu = document.querySelector('[data-testid="block-menu"]')!
    const labels = Array.from(menu.querySelectorAll('button')).map(b => b.textContent ?? '')
    const unwrap = menu.querySelector('[data-testid="block-menu-unwrap"]')
    unwrap?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return labels
  }

  it('le callout part, son titre et son corps restent', async () => {
    const doc = 'avant\n\n> [!TIP] Mon titre\n> Du **gras**\n> - un\n\napres'
    const view = setup(doc, 0, 'classic', registryOf(await calloutSpec()))
    expect(retirer(view, '.callout')).toContain('Retirer le callout')
    expect(view.state.doc.toString()).toBe('avant\n\nMon titre\n\nDu **gras**\n- un\n\napres')
    view.destroy()
  })

  it('colonnes et code sans plugin : l\'editeur sait les retirer', () => {
    const doc = 'avant\n\n::: colonnes 1 1\ngauche\n+++\ndroite\n:::\n\n```js\nf(x)\n```\n\napres'
    const view = setup(doc, 0, 'classic')
    expect(retirer(view, '.plume-columns-wrap')).toContain('Retirer les colonnes')
    expect(view.state.doc.toString()).toBe('avant\n\ngauche\n\ndroite\n\n```js\nf(x)\n```\n\napres')
    expect(retirer(view, '.plume-object pre')).toContain('Retirer le bloc de code')
    expect(view.state.doc.toString()).toBe('avant\n\ngauche\n\ndroite\n\nf(x)\n\napres')
    view.destroy()
  })
})
