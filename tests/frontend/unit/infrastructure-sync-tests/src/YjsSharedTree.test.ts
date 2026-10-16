// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Adaptateur Yjs -> ISharedTree : comportement commun, puis fusion
// concurrente (deux Y.Doc qui echangent leurs mises a jour en differe).
import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import type { ITreeElement, ITreeList, ITreeText } from '@savoire/plugin-api'
import { YjsSharedTree } from '@savoire/infrastructure-sync'
import { describeSharedTreeBehaviour } from './contract/sharedTreeBehaviour'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Y_ = Y as Record<string, any>

/** Deux Y.Doc dont les mises a jour attendent sync() pour passer. */
function pair() {
  const docA = new Y_.Doc()
  const docB = new Y_.Doc()
  const pending: { to: unknown; update: Uint8Array }[] = []
  docA.on('update', (u: Uint8Array, origin: unknown) => { if (origin !== 'remote') pending.push({ to: docB, update: u }) })
  docB.on('update', (u: Uint8Array, origin: unknown) => { if (origin !== 'remote') pending.push({ to: docA, update: u }) })
  const sync = (): void => {
    for (const { to, update } of pending.splice(0)) Y_.applyUpdate(to, update, 'remote')
  }
  return { a: new YjsSharedTree(docA), b: new YjsSharedTree(docB), sync, docA }
}

describeSharedTreeBehaviour('adaptateur Yjs', pair)

describe('YjsSharedTree — fusion concurrente', () => {
  it('deux membres editent le meme paragraphe et la meme liste en meme temps', () => {
    const { a, b, sync } = pair()
    a.root.set('doc', { kind: 'element', name: 'doc', children: [
      { kind: 'element', name: 'paragraph', children: [{ kind: 'text', delta: [{ insert: 'abc' }] }] },
    ] })
    a.root.set('liste', { kind: 'list', items: [1, 2] })
    sync()
    const textA = ((a.root.get('doc') as ITreeElement).get(0) as ITreeElement).get(0) as ITreeText
    const textB = ((b.root.get('doc') as ITreeElement).get(0) as ITreeElement).get(0) as ITreeText
    textA.insert(1, 'X')
    textB.format(0, 3, { bold: true })
    textB.insert(3, 'Y', { bold: true })
    ;(a.root.get('liste') as ITreeList).push([3])
    ;(b.root.get('liste') as ITreeList).insert(0, [0])
    ;(a.root.get('doc') as ITreeElement).push([{ kind: 'element', name: 'paragraph' }])
    ;(b.root.get('doc') as ITreeElement).push([{ kind: 'element', name: 'horizontal_rule' }])
    sync()
    expect(a.root.toJSON()).toEqual(b.root.toJSON())
    expect(textA.toString()).toBe('aXbcY')
    expect((a.root.get('liste') as ITreeList).toJSON()).toEqual([0, 1, 2, 3])
    expect((a.root.get('doc') as ITreeElement).length).toBe(3)
  })

  it('un changement sur un noeud supprime en concurrence n\'est pas perdu de vue', () => {
    const { a, b, sync } = pair()
    const doc = a.root.set('doc', { kind: 'element', name: 'doc', children: [{ kind: 'text', delta: [{ insert: 'x' }] }] }) as ITreeElement
    sync()
    const tB = (b.root.get('doc') as ITreeElement).get(0) as ITreeText
    doc.delete(0)
    tB.insert(1, 'y')
    sync()
    expect(tB.deleted).toBe(true)
    expect(a.root.toJSON()).toEqual(b.root.toJSON())
  })

  it('le texte et l\'arbre vivent dans le meme Y.Doc sans se gener', () => {
    const { a, docA } = pair()
    docA.getText('codemirror').insert(0, 'texte')
    a.root.set('k', 'v')
    expect(docA.getText('codemirror').toString()).toBe('texte')
    expect(a.root.toJSON()).toEqual({ k: 'v' })
  })
})
