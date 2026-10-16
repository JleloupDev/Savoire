// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Excalidraw en edition simultanee : deux vues reliees par l'arbre partage
// (InMemorySharedTree.link), sans Excalidraw ni DOM. Chaque vue est un
// tableau d'elements, comme getSceneElementsIncludingDeleted().
import { describe, it, expect, vi, afterEach } from 'vitest'
import { InMemorySharedTree } from '@savoire/plugin-runtime'
import {
  SceneBinding, assignOrder, isBetter,
  type SceneElement, type SceneFile, type StoredFile,
} from '../../../../../packages/plugins/plugin-excalidraw/src/binding'

class FakeView {
  elements: SceneElement[] = []
  files: Record<string, SceneFile> = {}
  applied = 0
  busy = new Set<string>()
  readonly binding: SceneBinding

  constructor(readonly tree: InMemorySharedTree, opts: {
    storeFile?: (f: SceneFile) => Promise<StoredFile>
    loadFile?: (id: string, s: StoredFile) => Promise<SceneFile | null>
  } = {}) {
    this.binding = new SceneBinding({
      tree,
      getElements: () => this.elements,
      getBusyIds: () => this.busy,
      applyElements: els => { this.elements = els; this.applied++ },
      hasFile: id => !!this.files[id],
      addFiles: fs => { for (const f of fs) this.files[f.id] = f },
      storeFile: opts.storeFile,
      loadFile: opts.loadFile,
      throttleMs: 10,
    })
    this.binding.start()
  }

  /** Geste local, comme Excalidraw : nouvel objet, version + 1, nonce au hasard. */
  edit(id: string, props: Partial<SceneElement> = {}): void {
    const i = this.elements.findIndex(e => e.id === id)
    const prev = i >= 0 ? this.elements[i] : { id, version: 0, versionNonce: 0, type: 'rectangle', x: 0, y: 0 }
    const next = { ...prev, ...props, version: prev.version + 1, versionNonce: Math.floor(Math.random() * 1e9) }
    if (i >= 0) this.elements = this.elements.map(e => (e.id === id ? next : e))
    else this.elements = [...this.elements, next]
    this.binding.localChange(this.files)
  }

  reorder(ids: string[]): void {
    const byId = new Map(this.elements.map(e => [e.id, e]))
    this.elements = ids.map(id => byId.get(id)!)
    this.binding.localChange()
  }

  visible(): string[] { return this.elements.filter(e => !e.isDeleted).map(e => e.id) }
  get(id: string): SceneElement | undefined { return this.elements.find(e => e.id === id) }
}

function pair(opts?: ConstructorParameters<typeof FakeView>[1]) {
  const ta = new InMemorySharedTree()
  const tb = new InMemorySharedTree()
  InMemorySharedTree.link(ta, tb)
  return { a: new FakeView(ta, opts), b: new FakeView(tb, opts), ta, tb }
}

afterEach(() => { vi.useRealTimers() })

describe('plugin-excalidraw : ordre', () => {
  it('garde les rangs deja croissants et place les nouveaux entre leurs voisins', () => {
    const z = new Map([['a', 1], ['b', 2], ['c', 3]])
    expect(assignOrder(['a', 'b', 'c'], z).size).toBe(0)
    const ins = assignOrder(['a', 'x', 'b', 'c'], z)
    expect([...ins.keys()]).toEqual(['x'])
    expect(ins.get('x')!).toBeGreaterThan(1)
    expect(ins.get('x')!).toBeLessThan(2)
  })

  it('un element mis au fond ne change que son propre rang', () => {
    const z = new Map([['a', 1], ['b', 2], ['c', 3]])
    const out = assignOrder(['c', 'a', 'b'], z)
    expect([...out.keys()]).toEqual(['c'])
    expect(out.get('c')!).toBeLessThan(1)
  })

  it('renumerote quand il n\'y a plus de place', () => {
    const z = new Map([['a', 1], ['b', 1 + 1e-12]])
    const out = assignOrder(['a', 'x', 'b'], z)
    const all = new Map([...z, ...out])
    expect(all.get('a')! < all.get('x')! && all.get('x')! < all.get('b')!).toBe(true)
  })

  it('regle de fusion d\'Excalidraw', () => {
    expect(isBetter({ version: 3, versionNonce: 9 }, { version: 2, versionNonce: 1 })).toBe(true)
    expect(isBetter({ version: 2, versionNonce: 1 }, { version: 2, versionNonce: 5 })).toBe(true)
    expect(isBetter({ version: 2, versionNonce: 5 }, { version: 2, versionNonce: 1 })).toBe(false)
  })
})

describe('plugin-excalidraw : deux vues sur le meme dessin', () => {
  it('un document neuf reste vide tant que personne ne dessine', () => {
    const { ta } = pair()
    expect(ta.root.keys()).toEqual([])
  })

  it('ajout : l\'autre vue recoit l\'element, une cle par element', () => {
    const { a, b, ta } = pair()
    a.edit('r1', { x: 10 })
    a.binding.flush()
    expect(b.visible()).toEqual(['r1'])
    expect(b.get('r1')!.x).toBe(10)
    expect(ta.root.keys().sort()).toEqual(['el:r1', 'z:r1'])
  })

  it('pas d\'echo : ses propres ecritures ne reviennent pas dans la vue', () => {
    const { a, b } = pair()
    a.edit('r1')
    a.binding.flush()
    expect(a.applied).toBe(0)
    expect(b.applied).toBe(1)
    // La vue distante re-signale son onChange : rien a ecrire.
    const before = b.tree.root.get('el:r1')
    b.binding.localChange()
    b.binding.flush()
    expect(b.tree.root.get('el:r1')).toBe(before)
    expect(a.applied).toBe(0)
  })

  it('n\'ecrit que les elements dont la version a change', () => {
    const { a, ta } = pair()
    a.edit('r1'); a.edit('r2')
    a.binding.flush()
    const set = vi.spyOn(ta.root, 'set')
    a.edit('r2', { x: 5 })
    a.binding.flush()
    expect(set.mock.calls.map(c => c[0])).toEqual(['el:r2'])
  })

  it('ajouts concurrents : les deux elements sont la, dans le meme ordre', () => {
    const { a, b } = pair()
    a.edit('ra')
    b.edit('rb')
    a.binding.flush()
    b.binding.flush()
    expect(a.visible().sort()).toEqual(['ra', 'rb'])
    expect(a.visible()).toEqual(b.visible())
  })

  it('deplacement et suppression concurrents : la version la plus haute gagne partout', () => {
    const { a, b } = pair()
    a.edit('r1')
    a.binding.flush()
    // A deplace deux fois (version 3), B supprime (version 2), sans s'etre vus.
    a.edit('r1', { x: 50 }); a.edit('r1', { x: 60 })
    b.edit('r1', { isDeleted: true })
    b.binding.flush() // B ecrit d'abord : A garde sa version, meilleure, et la reecrit
    a.binding.flush()
    expect(a.get('r1')).toEqual(b.get('r1'))
    expect(a.get('r1')!.x).toBe(60)
    expect(a.get('r1')!.isDeleted).toBeFalsy()
    expect(JSON.parse(a.tree.root.get('el:r1') as string).x).toBe(60)
  })

  it('reecriture : une vue qui tient mieux que l\'arbre le corrige', () => {
    vi.useFakeTimers()
    const { a, b } = pair()
    a.edit('r1'); a.binding.flush()
    a.edit('r1', { x: 1 }); a.edit('r1', { x: 2 }) // version 3, pas encore ecrite
    b.edit('r1', { x: 9 }) // version 2
    b.binding.flush()
    // A a recu une version moins bonne : elle garde la sienne...
    expect(a.get('r1')!.x).toBe(2)
    // ...et la reecrit au prochain passage, que B adopte.
    vi.advanceTimersByTime(20)
    expect(b.get('r1')!.x).toBe(2)
    expect(a.get('r1')).toEqual(b.get('r1'))
  })

  it('un element en cours de geste n\'est pas remplace par un distant', () => {
    const { a, b } = pair()
    a.edit('r1'); a.binding.flush()
    b.busy.add('r1')
    b.edit('r1', { x: 3 })
    a.edit('r1', { x: 7 }); a.edit('r1', { x: 8 }) // meilleure version
    a.binding.flush()
    expect(b.get('r1')!.x).toBe(3)
  })

  it('ordre : un passage au premier plan arrive chez l\'autre', () => {
    const { a, b } = pair()
    a.edit('r1'); a.edit('r2'); a.edit('r3')
    a.binding.flush()
    expect(b.visible()).toEqual(['r1', 'r2', 'r3'])
    a.reorder(['r2', 'r3', 'r1'])
    a.binding.flush()
    expect(b.visible()).toEqual(['r2', 'r3', 'r1'])
  })

  it('ordre et deplacement concurrents ne s\'ecrasent pas', () => {
    const { a, b } = pair()
    a.edit('r1'); a.edit('r2')
    a.binding.flush()
    a.reorder(['r2', 'r1'])
    b.edit('r1', { x: 42 })
    a.binding.flush()
    b.binding.flush()
    expect(a.visible()).toEqual(['r2', 'r1'])
    expect(b.visible()).toEqual(['r2', 'r1'])
    expect(a.get('r1')!.x).toBe(42)
  })

  it('une troisieme vue ouverte apres coup lit l\'etat de l\'arbre', () => {
    const { a, ta } = pair()
    a.edit('r1'); a.edit('r2'); a.binding.flush()
    const later = new SceneBinding({
      tree: ta, getElements: () => null, applyElements: () => {}, hasFile: () => false, addFiles: () => {},
    })
    later.start()
    expect(later.readElements().map(e => e.id)).toEqual(['r1', 'r2'])
    expect(later.isEmpty()).toBe(false)
  })

  it('lecture seule : rien n\'est ecrit', () => {
    const { a, ta } = pair()
    a.binding.setWritable(false)
    a.edit('r1')
    a.binding.flush()
    expect(ta.root.keys()).toEqual([])
  })
})

describe('plugin-excalidraw : images', () => {
  it('une image collee part en piece jointe et l\'autre vue la recharge', async () => {
    const store = vi.fn(async (f: SceneFile): Promise<StoredFile> => ({ mimeType: f.mimeType, path: `attachments/${f.id}.png` }))
    const load = vi.fn(async (id: string, s: StoredFile): Promise<SceneFile> => ({ id, mimeType: s.mimeType, dataURL: 'data:image/png;base64,QUJD' }))
    const { a, b, ta } = pair({ storeFile: store, loadFile: load })
    a.files.f1 = { id: 'f1', mimeType: 'image/png', dataURL: 'data:image/png;base64,QUJD' }
    a.edit('img', { type: 'image', fileId: 'f1' })
    await vi.waitFor(() => expect(b.files.f1).toBeDefined())
    expect(store).toHaveBeenCalledTimes(1)
    expect(JSON.parse(ta.root.get('file:f1') as string)).toEqual({ mimeType: 'image/png', path: 'attachments/f1.png' })
    expect(ta.root.get('file:f1') as string).not.toContain('base64')
    // Deja connue : pas de second envoi.
    a.edit('img', { x: 1 })
    await Promise.resolve()
    expect(store).toHaveBeenCalledTimes(1)
  })

  it('sans pieces jointes, l\'image va dans l\'arbre', async () => {
    const { a, b } = pair()
    a.files.f1 = { id: 'f1', mimeType: 'image/png', dataURL: 'data:image/png;base64,QUJD' }
    a.edit('img', { type: 'image', fileId: 'f1' })
    await vi.waitFor(() => expect(b.files.f1?.dataURL).toBe('data:image/png;base64,QUJD'))
  })
})
