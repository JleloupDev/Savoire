// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Carte mentale : modele plat sur l'arbre partage (sans DOM, sans mind-elixir).
// Operations -> ecritures ciblees, lecture reparee (orphelins, cycles,
// racines en trop), cles de tri, recalage d'un titre edite en concurrence.
import { describe, expect, it } from 'vitest'
import { InMemorySharedTree } from '@savoire/plugin-runtime'
import type { ITreeMap } from '@savoire/plugin-api'
import {
  NODE_PREFIX,
  materialize,
  readModel,
  requestFor,
  resolveParents,
  topicDelta,
  writeAll,
  writeFromView,
  type FlatNode,
  type FlatModel,
} from '../../../../../packages/plugins/plugin-mindmap/src/model'
import { keyBetween, reorderKeys } from '../../../../../packages/plugins/plugin-mindmap/src/order'

// Types de mind-elixir, vus par le modele (le paquet n'est pas une dependance des tests).
type MindElixirData = Parameters<typeof writeAll>[1]
type NodeObj = MindElixirData['nodeData']

/** Petit arbre ecrit a la main : [id, topic, enfants]. */
type Spec = [string, string, Spec[]?]
function nodes(spec: Spec): NodeObj {
  const [id, topic, kids] = spec
  return { id, topic, children: (kids ?? []).map(nodes) }
}
function data(spec: Spec, extra: Partial<MindElixirData> = {}): MindElixirData {
  return { nodeData: nodes(spec), ...extra }
}

/** Forme lisible d'une carte : « root(a(a1) b) ». */
function shape(n: NodeObj): string {
  const kids = n.children ?? []
  return kids.length ? `${n.topic}(${kids.map(shape).join(' ')})` : n.topic
}

function read(tree: InMemorySharedTree): string {
  const d = materialize(readModel(tree))
  return d ? shape(d.nodeData) : '<vide>'
}

function flat(entries: Array<[string, string | null, string]>): FlatModel {
  const m: FlatModel = { nodes: new Map(), arrows: new Map(), summaries: new Map() }
  for (const [id, parent, order] of entries) {
    m.nodes.set(id, { id, parent, order, topic: id, props: {} } satisfies FlatNode)
  }
  return m
}

describe('plugin-mindmap — cles de tri fractionnaires', () => {
  it('fabrique toujours une cle strictement entre ses voisines', () => {
    const keys: string[] = []
    let seed = 7
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }
    for (let i = 0; i < 400; i++) {
      const at = rand(keys.length + 1)
      const k = keyBetween(keys[at - 1] ?? null, keys[at] ?? null)
      if (at > 0) expect(k > keys[at - 1]).toBe(true)
      if (at < keys.length) expect(k < keys[at]).toBe(true)
      expect(k.endsWith('0')).toBe(false)
      keys.splice(at, 0, k)
    }
    expect([...keys].sort()).toEqual(keys)
  })

  it('reordonne en changeant le moins de cles possible', () => {
    // m deplace en tete : seule sa cle change.
    const out = reorderKeys(['m', 'a', 'c', 'd'])
    expect([...out.keys()]).toEqual([0])
    expect(out.get(0)! < 'a').toBe(true)
    // Sans cle (noeud neuf) : il en recoit une entre ses voisins.
    const fresh = reorderKeys(['a', null, 'c'])
    expect(fresh.get(1)! > 'a' && fresh.get(1)! < 'c').toBe(true)
  })
})

describe('plugin-mindmap — operations -> ecritures', () => {
  it('carte neuve : la premiere modification pose la racine et l\'enfant', () => {
    const tree = new InMemorySharedTree()
    expect(read(tree)).toBe('<vide>')
    const view = data(['root', 'Carte', [['a', 'A']]])
    tree.transact(() => writeFromView(tree, view, requestFor({ name: 'addChild', obj: view.nodeData.children![0] }, view)!))
    expect(read(tree)).toBe('Carte(A)')
    expect(tree.root.keys().sort()).toEqual([NODE_PREFIX + 'a', NODE_PREFIX + 'root'])
  })

  it('n\'ecrit que les noeuds touches : une vue en retard n\'ecrase rien', () => {
    const tree = new InMemorySharedTree()
    writeAll(tree, data(['root', 'R', [['a', 'A'], ['b', 'B']]]))
    // Un autre membre renomme b ; notre vue ne l'a pas encore vu.
    const b = tree.root.get(NODE_PREFIX + 'b') as ITreeMap
    ;(b.get('topic') as { insert(i: number, t: string): void }).insert(1, '2')
    // Nous renommons a.
    const stale = data(['root', 'R', [['a', 'A!'], ['b', 'B']]])
    tree.transact(() => writeFromView(tree, stale, requestFor({ name: 'finishEdit', obj: stale.nodeData.children![0], origin: 'A' }, stale)!))
    expect(read(tree)).toBe('R(A! B2)')
  })

  it('deplacer change parent et ordre, sans recreer le noeud', () => {
    const tree = new InMemorySharedTree()
    writeAll(tree, data(['root', 'R', [['a', 'A', [['x', 'X']]], ['b', 'B']]]))
    const before = tree.root.get(NODE_PREFIX + 'x')
    const moved = data(['root', 'R', [['a', 'A'], ['b', 'B', [['x', 'X']]]]])
    tree.transact(() => writeFromView(tree, moved, requestFor({ name: 'moveNodeIn', objs: [{ id: 'x' }], toObj: { id: 'b' } }, moved)!))
    expect(read(tree)).toBe('R(A B(X))')
    expect(tree.root.get(NODE_PREFIX + 'x')).toBe(before)
  })

  it('monter un frere ne reecrit que sa cle', () => {
    const tree = new InMemorySharedTree()
    writeAll(tree, data(['root', 'R', [['a', 'A'], ['b', 'B'], ['c', 'C']]]))
    const order = (id: string) => (tree.root.get(NODE_PREFIX + id) as ITreeMap).get('order')
    const [oa, ob] = [order('a'), order('b')]
    const view = data(['root', 'R', [['a', 'A'], ['c', 'C'], ['b', 'B']]])
    tree.transact(() => writeFromView(tree, view, requestFor({ name: 'moveUpNode', obj: { id: 'c' } }, view)!))
    expect(read(tree)).toBe('R(A C B)')
    expect([order('a'), order('b')]).toEqual([oa, ob])
  })

  it('supprimer un noeud supprime son sous-arbre', () => {
    const tree = new InMemorySharedTree()
    const full = data(['root', 'R', [['a', 'A', [['a1', 'A1', [['a2', 'A2']]]]], ['b', 'B']]])
    writeAll(tree, full)
    const removed = full.nodeData.children![0]
    const view = data(['root', 'R', [['b', 'B']]])
    tree.transact(() => writeFromView(tree, view, requestFor({ name: 'removeNode', obj: removed }, view)!))
    expect(read(tree)).toBe('R(B)')
    expect(tree.root.keys().sort()).toEqual([NODE_PREFIX + 'b', NODE_PREFIX + 'root'])
  })

  it('proprietes, fleches et resumes partages ; le pliage reste local', () => {
    const tree = new InMemorySharedTree()
    const view = data(['root', 'R', [['a', 'A'], ['b', 'B']]], {
      arrows: [{ id: 'f', label: 'lien', from: 'a', to: 'b', delta1: { x: 1, y: 2 }, delta2: { x: 3, y: 4 } }],
      summaries: [{ id: 's', text: 'tout', parent: 'root', start: 0, end: 1 }],
    })
    view.nodeData.children![0].style = { color: '#f00' }
    view.nodeData.children![0].expanded = false
    view.nodeData.children![0].dangerouslySetInnerHTML = '<img onerror=alert(1)>'
    writeAll(tree, view)
    const back = materialize(readModel(tree))!
    expect(back.nodeData.children![0].style).toEqual({ color: '#f00' })
    expect(back.nodeData.children![0].expanded).toBeUndefined()
    expect(back.nodeData.children![0].dangerouslySetInnerHTML).toBeUndefined()
    expect(back.arrows).toEqual([view.arrows![0]])
    expect(back.summaries).toEqual([view.summaries![0]])
    // Le pliage vient de la vue qui lit.
    const folded = materialize(readModel(tree), new Set(['root']))!
    expect(folded.nodeData.expanded).toBe(false)
  })

  it('debut d\'edition : rien a ecrire', () => {
    expect(requestFor({ name: 'beginEdit', obj: { id: 'a' } }, data(['root', 'R']))).toBeNull()
  })
})

describe('plugin-mindmap — deux membres relies', () => {
  it('ce qu\'ecrit l\'un, l\'autre le lit a l\'identique', () => {
    const a = new InMemorySharedTree()
    const b = new InMemorySharedTree()
    InMemorySharedTree.link(a, b)
    const view = data(['root', 'R', [['x', 'X', [['y', 'Y']]], ['z', 'Z']]])
    a.transact(() => writeAll(a, view))
    expect(read(b)).toBe('R(X(Y) Z)')
    expect(materialize(readModel(b))).toEqual(materialize(readModel(a)))
  })
})

describe('plugin-mindmap — reparation apres fusion concurrente', () => {
  it('cycle (A dans B, B dans A) : casse au plus petit id, rattache a la racine', () => {
    const m = flat([['root', null, 'V'], ['a', 'b', 'V'], ['b', 'a', 'V'], ['c', 'a', 'V']])
    const r = resolveParents(m.nodes)!
    expect(r.parentOf.get('a')).toBe('root')
    expect(r.parentOf.get('b')).toBe('a')
    expect(r.parentOf.get('c')).toBe('a')
    expect(shape(materialize(m)!.nodeData)).toBe('root(a(b c))')
  })

  it('parent supprime pendant l\'ajout d\'un enfant : l\'orphelin va sous la racine', () => {
    const m = flat([['root', null, 'V'], ['b', 'root', 'k'], ['orphan', 'gone', 'V']])
    expect(shape(materialize(m)!.nodeData)).toBe('root(orphan b)')
  })

  it('deux racines : la plus petite gagne, l\'autre devient son enfant', () => {
    const m = flat([['r2', null, 'V'], ['r1', null, 'V'], ['x', 'r2', 'V']])
    expect(shape(materialize(m)!.nodeData)).toBe('r1(r2(x))')
  })

  it('deux insertions au meme endroit (cles egales) : departagees par id', () => {
    const m = flat([['root', null, 'V'], ['q', 'root', 'V'], ['p', 'root', 'V']])
    expect(shape(materialize(m)!.nodeData)).toBe('root(p q)')
  })

  it('un resume dont les positions debordent est ramene dans les bornes', () => {
    const m = flat([['root', null, 'V'], ['a', 'root', 'V']])
    m.summaries.set('s', { text: 't', parent: 'root', start: 0, end: 5 })
    m.summaries.set('t', { text: 't', parent: 'gone', start: 0, end: 0 })
    expect(materialize(m)!.summaries).toEqual([{ id: 's', text: 't', parent: 'root', start: 0, end: 0 }])
  })
})

describe('plugin-mindmap — titre edite en concurrence', () => {
  const apply = (s: string, delta: ReturnType<typeof topicDelta>) => {
    let pos = 0
    let out = s
    for (const op of delta) {
      if ('retain' in op) pos += op.retain
      else if ('delete' in op) out = out.slice(0, pos) + out.slice(pos + op.delete)
      else { out = out.slice(0, pos) + op.insert + out.slice(pos); pos += op.insert.length }
    }
    return out
  }

  it('sans concurrence : changement minimal', () => {
    expect(topicDelta('Bonjour', 'Bonjour', 'Bonsoir')).toEqual([{ retain: 3 }, { delete: 3 }, { insert: 'soi' }])
  })

  it('l\'autre a ecrit apres : on garde son ajout', () => {
    // base « idee », nous : « Une idee », l'autre a ajoute « ! » a la fin.
    expect(apply('idee !', topicDelta('idee !', 'idee', 'Une idee'))).toBe('Une idee !')
  })

  it('l\'autre a ecrit avant : recale par le suffixe', () => {
    expect(apply('Grande idee', topicDelta('Grande idee', 'idee', 'idee !'))).toBe('Grande idee !')
  })
})
