// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Carte mentale : deux vues mind-elixir reliees par deux arbres partages en
// memoire, comme deux membres d'un vault. Plus les commandes du moteur de
// raccourcis et la migration d'un ancien fichier.
import { afterEach, describe, expect, it } from 'vitest'
import { CommandRegistryImpl, HotkeyManager, InMemorySharedTree } from '@savoire/plugin-runtime'
import type { MindmapEditor as MindmapEditorType } from '../../../../../packages/plugins/plugin-mindmap/src/view'
import { materialize, readModel, type writeAll } from '../../../../../packages/plugins/plugin-mindmap/src/model'

// Types de mind-elixir, vus par le modele (le paquet n'est pas une dependance des tests).
type MindElixirData = Parameters<typeof writeAll>[1]
type NodeObj = MindElixirData['nodeData']

// mind-elixir lit, a son chargement, l'attribut d'une balise <script> de la
// page (ses icones) : il en faut une avant de l'importer.
document.head.appendChild(document.createElement('script'))
const { MindmapEditor } = await import('../../../../../packages/plugins/plugin-mindmap/src/view')
const { mindmapCommands } = await import('../../../../../packages/plugins/plugin-mindmap/src/commands')
type MindmapEditor = MindmapEditorType

const editors: MindmapEditor[] = []

function editor(opts: Partial<ConstructorParameters<typeof MindmapEditor>[0]> = {}): MindmapEditor {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  const ed = new MindmapEditor({ parent, title: 'Carte', ...opts })
  editors.push(ed)
  return ed
}

function pair() {
  const ta = new InMemorySharedTree()
  const tb = new InMemorySharedTree()
  InMemorySharedTree.link(ta, tb)
  return { ta, tb, a: editor({ tree: ta }), b: editor({ tree: tb }) }
}

function shape(n: NodeObj): string {
  const kids = n.children ?? []
  return kids.length ? `${n.topic}(${kids.map(shape).join(' ')})` : n.topic
}
const view = (ed: MindmapEditor) => shape(ed.me.getData().nodeData)
const model = (t: InMemorySharedTree) => { const d = materialize(readModel(t)); return d ? shape(d.nodeData) : '<vide>' }

/** Laisse passer les promesses (operations async de mind-elixir) et les rendus. */
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)) }

/** Termine l'edition de titre en cours avec ce texte. */
function type(ed: MindmapEditor, text: string) {
  const box = ed.dom.querySelector('#input-box') as HTMLElement
  expect(box).toBeTruthy()
  box.textContent = text
  box.blur()
}

function select(ed: MindmapEditor, id: string) {
  ed.me.selectNode(ed.me.findEle(id, ed.me))
}

afterEach(() => {
  while (editors.length) editors.pop()!.destroy()
  document.body.replaceChildren()
})

describe('plugin-mindmap — deux vues reliees', () => {
  it('carte neuve : rien n\'est ecrit a l\'ouverture', () => {
    const { ta, a } = pair()
    expect(view(a)).toBe('Carte')
    expect(ta.root.keys()).toEqual([])
  })

  it('un ajout et un renommage dans A apparaissent dans B', async () => {
    const { ta, a, b } = pair()
    select(a, 'root')
    await a.me.addChild()
    await settle()
    type(a, 'Idee')
    await settle()
    expect(model(ta)).toBe('Carte(Idee)')
    expect(view(b)).toBe('Carte(Idee)')
    expect(view(a)).toBe('Carte(Idee)')
  })

  it('pendant qu\'on edite un titre, la vue attend la fin de l\'edition', async () => {
    const { a, b } = pair()
    select(a, 'root')
    await a.me.addChild()
    await settle()
    type(a, 'X')
    await settle()
    const x = a.me.getData().nodeData.children![0].id

    // B edite le titre de X...
    select(b, x)
    await b.me.beginEdit()
    expect(b.dom.querySelector('#input-box')).toBeTruthy()
    // ... pendant que A ajoute un frere (deja nomme : A ne prend pas le
    // focus, une page de test n'en a qu'un).
    await a.me.insertSibling('after', a.me.findEle(x, a.me), { id: 'y', topic: 'Y' })
    await settle()
    expect(view(a)).toBe('Carte(X Y)')
    // La saisie de B n'a pas ete detruite.
    expect(b.dom.querySelector('#input-box')).toBeTruthy()
    type(b, 'X2')
    await settle()
    expect(view(b)).toBe('Carte(X2 Y)')
    expect(view(a)).toBe('Carte(X2 Y)')
  })

  it('suppression et deplacement se propagent, la selection est gardee', async () => {
    const { a, b } = pair()
    select(a, 'root')
    await a.me.addChild(); await settle(); type(a, 'A'); await settle()
    select(a, 'root')
    await a.me.addChild(); await settle(); type(a, 'B'); await settle()
    const [ida, idb] = a.me.getData().nodeData.children!.map(c => c.id)
    select(b, ida)

    await a.me.moveNodeIn([a.me.findEle(idb, a.me)], a.me.findEle(ida, a.me))
    await settle()
    expect(view(b)).toBe('Carte(A(B))')
    expect(b.me.currentNode?.nodeObj.id).toBe(ida)

    select(a, idb)
    await a.me.removeNode()
    await settle()
    expect(view(b)).toBe('Carte(A)')
  })

  it('lecture seule : aucune operation n\'est faite ni ecrite', async () => {
    const ta = new InMemorySharedTree()
    const ed = editor({ tree: ta, readOnly: true })
    select(ed, 'root')
    await ed.me.addChild()
    await settle()
    expect(view(ed)).toBe('Carte')
    expect(ta.root.keys()).toEqual([])
  })
})

describe('plugin-mindmap — ancien fichier', () => {
  const legacy: MindElixirData = {
    nodeData: { id: 'old-root', topic: 'Ancienne', children: [{ id: 'o1', topic: 'Un' }] },
  }

  it('affiche l\'ancien contenu sans l\'ecrire, puis le recopie a la premiere modification', async () => {
    const ta = new InMemorySharedTree()
    let migrated = 0
    const ed = editor({ tree: ta, onMigrated: () => { migrated++ } })
    ed.setLegacy(legacy)
    expect(view(ed)).toBe('Ancienne(Un)')
    expect(ta.root.keys()).toEqual([])

    select(ed, 'o1')
    await ed.me.addChild()
    await settle()
    type(ed, 'Deux')
    await settle()
    expect(model(ta)).toBe('Ancienne(Un(Deux))')
    expect(migrated).toBe(1)
  })

  it('l\'arbre deja rempli l\'emporte sur l\'ancien contenu', async () => {
    const { ta, tb, a, b } = pair()
    select(a, 'root')
    await a.me.addChild(); await settle(); type(a, 'Neuf'); await settle()
    b.setLegacy(legacy)
    expect(view(b)).toBe('Carte(Neuf)')
    expect(model(tb)).toBe(model(ta))
  })
})

describe('plugin-mindmap — commandes du moteur de raccourcis', () => {
  function engine() {
    const registry = new CommandRegistryImpl()
    for (const c of mindmapCommands()) registry.register(c)
    return new HotkeyManager(registry)
  }

  it('Tab ajoute un enfant quand une carte a le focus, et seulement alors', async () => {
    const hotkeys = engine()
    const ta = new InMemorySharedTree()
    const ed = editor({ tree: ta, onKeyDown: e => hotkeys.handleKeyEvent(e, { editorView: null }) })
    select(ed, 'root')

    // Sans focus dans la carte : la touche n'est pas prise.
    const outside = new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', cancelable: true })
    expect(hotkeys.handleKeyEvent(outside, { editorView: null })).toBe(false)

    ed.me.map.focus()
    const tab = new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true, cancelable: true })
    ed.me.map.dispatchEvent(tab)
    expect(tab.defaultPrevented).toBe(true)
    await settle()
    type(ed, 'Enfant')
    await settle()
    expect(model(ta)).toBe('Carte(Enfant)')
  })

  it('fleches : navigation entre noeuds', async () => {
    const hotkeys = engine()
    const ta = new InMemorySharedTree()
    const ed = editor({ tree: ta, onKeyDown: e => hotkeys.handleKeyEvent(e, { editorView: null }) })
    select(ed, 'root')
    await ed.me.addChild(); await settle(); type(ed, 'A'); await settle()
    select(ed, 'root')
    await ed.me.addChild(); await settle(); type(ed, 'B'); await settle()
    const [ida, idb] = ed.me.getData().nodeData.children!.map(c => c.id)

    ed.me.map.focus()
    const press = (key: string) => ed.me.map.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true }))
    select(ed, idb)
    ed.me.map.focus()
    press('ArrowUp')
    expect(ed.me.currentNode?.nodeObj.id).toBe(ida)
    press('ArrowLeft')
    expect(ed.me.currentNode?.nodeObj.id).toBe('root')
    press('ArrowRight')
    expect(ed.me.currentNode?.nodeObj.id).toBe(ida)
  })
})
