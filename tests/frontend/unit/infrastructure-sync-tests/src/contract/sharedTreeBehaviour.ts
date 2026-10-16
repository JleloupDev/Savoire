// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Comportement commun de ISharedTree, quelle que soit l'implementation
// (memoire de reference, adaptateur Yjs). Deux membres, ecritures dans
// l'ordre ; la fusion concurrente est testee a part, la ou elle existe.
import { describe, it, expect } from 'vitest'
import type { ISharedTree, ITreeElement, ITreeMap, ITreeText, TreeChange, TreeChangeInfo } from '@savoire/plugin-api'

export interface SharedTreePair {
  a: ISharedTree
  b: ISharedTree
  /** Fait arriver chez l'autre ce que chacun a ecrit. */
  sync(): void
}

type Batch = { changes: TreeChange[]; info: TreeChangeInfo }

function recorder(tree: ISharedTree): Batch[] {
  const seen: Batch[] = []
  tree.onChange((changes, info) => { seen.push({ changes, info }) })
  return seen
}

/** Une page ProseMirror : doc > paragraphe > texte avec une marque. */
function writePage(tree: ISharedTree): ITreeElement {
  return tree.root.set('doc', {
    kind: 'element', name: 'doc', children: [
      { kind: 'element', name: 'heading', attributes: { level: 1 }, children: [{ kind: 'text', delta: [{ insert: 'Titre' }] }] },
      { kind: 'element', name: 'paragraph', children: [
        { kind: 'text', delta: [{ insert: 'du ' }, { insert: 'gras', attributes: { bold: true } }] },
      ] },
    ],
  }) as ITreeElement
}

export function describeSharedTreeBehaviour(name: string, makePair: () => SharedTreePair): void {
  describe(`ISharedTree — ${name}`, () => {
    it('represente une page ProseMirror et la recopie chez l\'autre membre', () => {
      const { a, b, sync } = makePair()
      const doc = writePage(a)
      sync()
      const docB = b.root.get('doc') as ITreeElement
      expect(docB.kind).toBe('element')
      expect(docB.toJSON()).toEqual(doc.toJSON())
      expect(docB.toJSON()).toEqual({
        name: 'doc', attributes: {}, children: [
          { name: 'heading', attributes: { level: 1 }, children: ['Titre'] },
          { name: 'paragraph', attributes: {}, children: ['du gras'] },
        ],
      })
      const textB = (docB.get(1) as ITreeElement).get(0) as ITreeText
      expect(textB.toDelta()).toEqual([{ insert: 'du ' }, { insert: 'gras', attributes: { bold: true } }])
    })

    it('un noeud a le meme id chez les deux membres, et une poignee stable', () => {
      const { a, b, sync } = makePair()
      const doc = writePage(a)
      sync()
      const docB = b.root.get('doc') as ITreeElement
      expect(docB.id).toBe(doc.id)
      expect(docB.get(0)!.id).toBe(doc.get(0)!.id)
      expect(b.root.get('doc')).toBe(docB)
      expect(docB.get(0)).toBe(docB.get(0))
      expect(docB.parent).toBe(b.root)
      expect(b.root.parent).toBeNull()
    })

    it('ses ecritures arrivent en local avec l\'etiquette, chez l\'autre en distant sans etiquette', () => {
      const { a, b, sync } = makePair()
      const seenA = recorder(a)
      const seenB = recorder(b)
      a.transact(() => { a.root.set('titre', 'x'); a.root.set('n', 1) }, 'miroir')
      expect(seenA).toHaveLength(1)
      expect(seenA[0].info).toEqual({ origin: 'local', tag: 'miroir' })
      sync()
      expect(seenB).toHaveLength(1)
      expect(seenB[0].info).toEqual({ origin: 'remote' })
      expect(b.root.get('titre')).toBe('x')
      a.root.set('sans', true)
      expect(seenA[1].info).toEqual({ origin: 'local' })
    })

    it('un noeud cree dans la transaction n\'a pas de changement propre', () => {
      const { a, b, sync } = makePair()
      const doc = writePage(a)
      sync()
      const seenA = recorder(a)
      const seenB = recorder(b)
      a.transact(() => {
        const [p] = doc.insert(2, [{ kind: 'element', name: 'paragraph' }]) as ITreeElement[]
        const [t] = p.insert(0, [{ kind: 'text' }]) as ITreeText[]
        t.insert(0, 'nouveau')
      })
      expect(seenA).toHaveLength(1)
      expect(seenA[0].changes).toHaveLength(1)
      const change = seenA[0].changes[0]
      expect(change.kind).toBe('element')
      expect(change.target).toBe(doc)
      if (change.kind !== 'element') throw new Error('attendu : element')
      expect(change.children).toEqual([{ retain: 2 }, { insert: [doc.get(2)] }])
      expect(doc.get(2)!.toJSON()).toEqual({ name: 'paragraph', attributes: {}, children: ['nouveau'] })
      sync()
      expect(seenB).toHaveLength(1)
      expect(seenB[0].changes.map(c => c.kind)).toEqual(['element'])
      expect((b.root.get('doc') as ITreeElement).toJSON()).toEqual(doc.toJSON())
    })

    it('texte riche : formats poses et retires, sans heritage a l\'insertion', () => {
      const { a, b, sync } = makePair()
      const t = a.root.set('t', { kind: 'text', delta: [{ insert: 'abcdef' }] }) as ITreeText
      sync()
      const seenB = recorder(b)
      t.format(1, 3, { bold: true, link: { href: 'https://x' } })
      t.insert(4, 'Z')
      t.format(2, 1, { bold: null })
      expect(t.toDelta()).toEqual([
        { insert: 'a' },
        { insert: 'b', attributes: { bold: true, link: { href: 'https://x' } } },
        { insert: 'c', attributes: { link: { href: 'https://x' } } },
        { insert: 'd', attributes: { bold: true, link: { href: 'https://x' } } },
        { insert: 'Zef' },
      ])
      sync()
      expect((b.root.get('t') as ITreeText).toDelta()).toEqual(t.toDelta())
      expect(seenB.length).toBeGreaterThan(0)
      expect(seenB.every(s => s.info.origin === 'remote' && s.changes.every(c => c.kind === 'text'))).toBe(true)
    })

    it('applyDelta de texte riche : une seule modification', () => {
      const { a } = makePair()
      const t = a.root.set('t', { kind: 'text', delta: [{ insert: 'bonjour\n' }] }) as ITreeText
      const seen = recorder(a)
      t.applyDelta([{ retain: 3, attributes: { italic: true } }, { delete: 4 }, { insert: 'soir', attributes: { bold: true } }])
      expect(seen).toHaveLength(1)
      expect(t.toString()).toBe('bonsoir\n')
      expect(t.toDelta()).toEqual([
        { insert: 'bon', attributes: { italic: true } },
        { insert: 'soir', attributes: { bold: true } },
        { insert: '\n' },
      ])
    })

    it('cartes et listes : ecrire, inserer, supprimer, et le noeud retire est marque', () => {
      const { a, b, sync } = makePair()
      const m = a.root.set('meta', { kind: 'map', entries: { tags: { kind: 'list', items: ['x', 'y'] }, n: 1 } }) as ITreeMap
      sync()
      const seenB = recorder(b)
      const tags = m.get('tags') as import('@savoire/plugin-api').ITreeList
      tags.insert(1, ['z'])
      tags.delete(0)
      m.delete('n')
      sync()
      expect(b.root.toJSON()).toEqual({ meta: { tags: ['z', 'y'] } })
      expect(seenB.flatMap(s => s.changes.map(c => c.kind)).sort()).toEqual(['list', 'list', 'map'])
      const mapChange = seenB.flatMap(s => s.changes).find(c => c.kind === 'map')
      expect(mapChange && mapChange.kind === 'map' && mapChange.keys).toEqual(['n'])
      a.root.delete('meta')
      expect(m.deleted).toBe(true)
      expect(tags.deleted).toBe(true)
      expect(a.root.has('meta')).toBe(false)
    })

    it('attributs d\'element : changement signale par nom', () => {
      const { a, b, sync } = makePair()
      const doc = writePage(a)
      sync()
      const heading = (b.root.get('doc') as ITreeElement).get(0) as ITreeElement
      const seen: string[][] = []
      heading.observe(change => { seen.push(change.attributes) })
      ;(doc.get(0) as ITreeElement).setAttribute('level', 2)
      ;(doc.get(0) as ITreeElement).setAttribute('id', { bloc: 'b1' })
      sync()
      expect(heading.getAttributes()).toEqual({ level: 2, id: { bloc: 'b1' } })
      expect(seen.flat().sort()).toEqual(['id', 'level'])
      ;(doc.get(0) as ITreeElement).removeAttribute('id')
      sync()
      expect(heading.getAttribute('id')).toBeUndefined()
    })

    it('refuse une valeur qui n\'est ni primitive ni un noeud', () => {
      const { a } = makePair()
      expect(() => a.root.set('x', { foo: 1 } as never)).toThrow('valeur invalide')
      const doc = writePage(a)
      expect(() => doc.insert(0, [{ kind: 'map' } as never])).toThrow('element ou texte')
    })
  })
}
