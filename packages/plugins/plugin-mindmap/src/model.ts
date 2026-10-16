// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Modele partage d'une carte mentale, sur l'arbre CRDT du document
// (ctx.tree). Fonctions pures : ni DOM, ni mind-elixir (types seulement).
//
// Modele PLAT. Chaque noeud est une entree de la racine de l'arbre :
//
//   node:<id>   carte { parent: id | null, order: cle de tri,
//                       topic: texte partage, 'p.<prop>': JSON }
//   arrow:<id>  JSON d'une fleche (remplacee en bloc)
//   summary:<id> JSON d'un resume (remplace en bloc)
//
// Pourquoi plat et pas imbrique :
//  - deplacer un noeud = changer son `parent` et son `order`. Dans un arbre
//    imbrique, il faudrait le supprimer et le recreer (l'API n'a pas de
//    deplacement) : une modification concurrente du noeud deplace serait
//    perdue, et deux deplacements concurrents dupliqueraient le noeud ;
//  - chaque noeud a ses propres cles : deux membres qui touchent deux noeuds
//    differents, ou deux proprietes differentes du meme noeud, ne
//    s'ecrasent jamais ;
//  - le titre est un texte partage : deux personnes qui modifient le meme
//    titre fusionnent caractere par caractere ;
//  - les entrees sont directement dans la racine, sans conteneur : il n'y a
//    pas de structure de depart a creer, donc pas de conteneur cree deux fois
//    en concurrence (le second ecraserait le premier et tout son contenu).
//
// Le prix : l'arbre peut etre incoherent apres une fusion. La lecture
// (materialize) le repare de facon deterministe, la meme chez tous :
//  - orphelin (parent supprime pendant qu'un autre lui ajoutait un enfant) :
//    rattache a la racine. Supprimer le travail de l'autre en silence serait
//    pire ; il le retrouve et le range ou l'efface lui-meme ;
//  - cycle (A deplace dans B pendant que B est deplace dans A) : le noeud du
//    cycle qui a le plus petit id est rattache a la racine ;
//  - plusieurs racines : celle qui a le plus petit id gagne, les autres
//    deviennent ses enfants.
// La reparation n'est pas ecrite : elle se recalcule a chaque lecture. Elle
// s'ecrit d'elle-meme quand quelqu'un touche le noeud.
//
// Ce qui reste propre a chaque vue (jamais ecrit) : le pliage (expanded),
// la disposition (gauche / droite / deux cotes), le zoom, la selection.
import type { ISharedTree, ITreeMap, ITreeText, RichTextDelta, TreeValue } from '@savoire/plugin-api'
import type { MindElixirData, NodeObj } from 'mind-elixir'
import { compareSiblings, reorderKeys } from './order'

export const NODE_PREFIX = 'node:'
export const ARROW_PREFIX = 'arrow:'
export const SUMMARY_PREFIX = 'summary:'
const PROP_PREFIX = 'p.'

/** Id de la racine d'une carte neuve : le meme chez tous les membres. */
export const ROOT_ID = 'root'

/**
 * Champs d'un NodeObj qui ne sont pas des proprietes partagees : la
 * structure (ecrite a part), l'etat de la vue, et le HTML brut (un membre
 * pourrait y glisser du script chez les autres).
 */
const NOT_PROPS = new Set(['id', 'topic', 'children', 'parent', 'expanded', 'dangerouslySetInnerHTML'])

export interface FlatNode {
  id: string
  parent: string | null
  order: string
  topic: string
  props: Record<string, unknown>
}

export interface FlatModel {
  nodes: Map<string, FlatNode>
  arrows: Map<string, Record<string, unknown>>
  summaries: Map<string, Record<string, unknown>>
}

function isMap(v: TreeValue | undefined): v is ITreeMap {
  return typeof v === 'object' && v !== null && v.kind === 'map'
}

function isText(v: TreeValue | undefined): v is ITreeText {
  return typeof v === 'object' && v !== null && v.kind === 'text'
}

function parseJson(v: TreeValue | undefined): unknown {
  if (typeof v !== 'string') return undefined
  try { return JSON.parse(v) } catch { return undefined }
}

function readNode(id: string, m: ITreeMap): FlatNode {
  const parent = m.get('parent')
  const order = m.get('order')
  const topic = m.get('topic')
  const props: Record<string, unknown> = {}
  for (const k of m.keys()) {
    if (!k.startsWith(PROP_PREFIX)) continue
    const v = parseJson(m.get(k))
    if (v !== undefined) props[k.slice(PROP_PREFIX.length)] = v
  }
  return {
    id,
    parent: typeof parent === 'string' ? parent : null,
    order: typeof order === 'string' ? order : '',
    topic: isText(topic) ? topic.toString() : typeof topic === 'string' ? topic : '',
    props,
  }
}

/** Lit le modele plat dans l'arbre partage. */
export function readModel(tree: ISharedTree): FlatModel {
  const model: FlatModel = { nodes: new Map(), arrows: new Map(), summaries: new Map() }
  for (const key of tree.root.keys()) {
    const v = tree.root.get(key)
    if (key.startsWith(NODE_PREFIX)) {
      if (isMap(v)) model.nodes.set(key.slice(NODE_PREFIX.length), readNode(key.slice(NODE_PREFIX.length), v))
    } else if (key.startsWith(ARROW_PREFIX)) {
      const a = parseJson(v)
      if (a && typeof a === 'object') model.arrows.set(key.slice(ARROW_PREFIX.length), a as Record<string, unknown>)
    } else if (key.startsWith(SUMMARY_PREFIX)) {
      const s = parseJson(v)
      if (s && typeof s === 'object') model.summaries.set(key.slice(SUMMARY_PREFIX.length), s as Record<string, unknown>)
    }
  }
  return model
}

/**
 * Parent effectif de chaque noeud, une fois l'arbre repare (orphelins,
 * cycles, racines en trop). Rend null si le modele est vide.
 */
export function resolveParents(nodes: Map<string, FlatNode>): { rootId: string; parentOf: Map<string, string> } | null {
  if (nodes.size === 0) return null
  const ids = [...nodes.keys()].sort()
  const roots = ids.filter(id => nodes.get(id)!.parent === null)
  const rootId = roots[0] ?? ids[0]
  const parentOf = new Map<string, string>()
  for (const id of ids) {
    if (id === rootId) continue
    const p = nodes.get(id)!.parent
    // Racine en trop, orphelin ou parent de soi-meme : sous la racine.
    parentOf.set(id, p === null || p === id || !nodes.has(p) ? rootId : p)
  }

  // Noeuds atteints depuis la racine.
  const reached = new Set<string>([rootId])
  const childrenOf = new Map<string, string[]>()
  for (const [id, p] of parentOf) {
    const list = childrenOf.get(p)
    if (list) list.push(id)
    else childrenOf.set(p, [id])
  }
  const reach = (from: string) => {
    const stack = [from]
    while (stack.length) {
      const id = stack.pop()!
      for (const c of childrenOf.get(id) ?? []) {
        if (reached.has(c)) continue
        reached.add(c)
        stack.push(c)
      }
    }
  }
  reach(rootId)

  // Les autres sont dans un cycle, ou sous un cycle. On casse chaque cycle
  // au noeud de plus petit id, dans l'ordre des ids : deterministe.
  for (const id of ids) {
    if (reached.has(id)) continue
    const path: string[] = []
    const seen = new Set<string>()
    let cur = id
    while (!reached.has(cur) && !seen.has(cur)) {
      seen.add(cur)
      path.push(cur)
      cur = parentOf.get(cur)!
    }
    if (reached.has(cur)) continue // ne devrait pas arriver
    const cycle = path.slice(path.indexOf(cur))
    const breakAt = [...cycle].sort()[0]
    const old = parentOf.get(breakAt)!
    childrenOf.set(old, (childrenOf.get(old) ?? []).filter(c => c !== breakAt))
    parentOf.set(breakAt, rootId)
    childrenOf.get(rootId)?.push(breakAt) ?? childrenOf.set(rootId, [breakAt])
    reached.add(breakAt)
    reach(breakAt)
  }
  return { rootId, parentOf }
}

/**
 * Donnees mind-elixir tirees du modele. `collapsed` : ids plies dans cette
 * vue (etat local). Rend null si le modele est vide.
 */
export function materialize(model: FlatModel, collapsed: ReadonlySet<string> = new Set()): MindElixirData | null {
  const resolved = resolveParents(model.nodes)
  if (!resolved) return null
  const { rootId, parentOf } = resolved

  const childrenOf = new Map<string, FlatNode[]>()
  for (const [id, p] of parentOf) {
    const list = childrenOf.get(p)
    const n = model.nodes.get(id)!
    if (list) list.push(n)
    else childrenOf.set(p, [n])
  }
  for (const list of childrenOf.values()) list.sort(compareSiblings)

  const build = (n: FlatNode): NodeObj => {
    const obj = { ...n.props, id: n.id, topic: n.topic } as NodeObj
    const kids = childrenOf.get(n.id) ?? []
    obj.children = kids.map(build)
    if (collapsed.has(n.id) && kids.length) obj.expanded = false
    return obj
  }
  const nodeData = build(model.nodes.get(rootId)!)

  const arrows = [...model.arrows.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, a]): Record<string, unknown> => ({ ...a, id }))
    .filter(a => typeof a.from === 'string' && typeof a.to === 'string'
      && model.nodes.has(a.from as string) && model.nodes.has(a.to as string))

  const summaries = [...model.summaries.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, s]): Record<string, unknown> => ({ ...s, id }))
    .flatMap(s => {
      // Un resume couvre des freres par position : apres une fusion, les
      // positions peuvent deborder. On les ramene dans les bornes.
      const count = typeof s.parent === 'string'
        ? (s.parent === rootId || parentOf.has(s.parent) ? (childrenOf.get(s.parent)?.length ?? 0) : 0)
        : 0
      if (count === 0) return []
      const clamp = (v: unknown) => Math.max(0, Math.min(count - 1, typeof v === 'number' ? v : 0))
      const start = clamp(s.start)
      const end = Math.max(start, clamp(s.end))
      return [{ ...s, start, end }]
    })

  return { nodeData, arrows, summaries } as unknown as MindElixirData
}

// ── Vue -> modele ─────────────────────────────────────────────────────────

interface ViewEntry {
  node: NodeObj
  parent: string | null
  siblings: string[]
}

/** Index des noeuds d'une vue : id -> noeud, parent, freres dans l'ordre. */
export function indexView(nodeData: NodeObj): Map<string, ViewEntry> {
  const out = new Map<string, ViewEntry>()
  const walk = (n: NodeObj, parent: string | null, siblings: string[]) => {
    out.set(n.id, { node: n, parent, siblings })
    const kids = (n.children ?? []).map(c => c.id)
    for (const c of n.children ?? []) walk(c, n.id, kids)
  }
  walk(nodeData, null, [nodeData.id])
  return out
}

/** Changement minimal d'un texte vers un autre : prefixe et suffixe communs. */
export function textEdit(from: string, to: string): { at: number; remove: number; insert: string } {
  let p = 0
  const max = Math.min(from.length, to.length)
  while (p < max && from[p] === to[p]) p++
  let s = 0
  while (s < max - p && from[from.length - 1 - s] === to[to.length - 1 - s]) s++
  return { at: p, remove: from.length - p - s, insert: to.slice(p, to.length - s) }
}

/**
 * Delta a appliquer au texte partage `current` pour y porter une edition
 * faite sur `base` (le titre au debut de l'edition) et qui a donne `next`.
 * Si `current` a change entre-temps (un autre membre), l'edition est
 * recalee par le prefixe ou le suffixe inchange ; sinon on remplace tout
 * (dernier ecrivain gagne, en dernier recours).
 */
export function topicDelta(current: string, base: string, next: string): RichTextDelta {
  const e = textEdit(base, next)
  const removed = base.slice(e.at, e.at + e.remove)
  const suffix = base.length - e.at - e.remove
  let at = -1
  if (current === base) at = e.at
  else if (current.slice(0, e.at) === base.slice(0, e.at) && current.slice(e.at, e.at + e.remove) === removed) at = e.at
  else {
    const pos = current.length - suffix - e.remove
    if (pos >= 0 && current.slice(current.length - suffix) === base.slice(base.length - suffix)
      && current.slice(pos, pos + e.remove) === removed) at = pos
  }
  if (at < 0) {
    const all = textEdit(current, next)
    return toDelta(all.at, all.remove, all.insert)
  }
  return toDelta(at, e.remove, e.insert)
}

function toDelta(at: number, remove: number, insert: string): RichTextDelta {
  const d: RichTextDelta = []
  if (at > 0) d.push({ retain: at })
  if (remove > 0) d.push({ delete: remove })
  if (insert) d.push({ insert })
  return d
}

export interface WriteRequest {
  /** Noeuds a ecrire : present dans la vue = cree ou mis a jour ; absent = supprime. */
  nodes?: Iterable<string>
  /** Titre au debut de l'edition, par id (pour recaler une edition concurrente). */
  topicBase?: Map<string, string>
  arrows?: Iterable<string>
  summaries?: Iterable<string>
}

/**
 * Ecrit dans l'arbre partage ce qui a change dans la vue, pour les noeuds
 * cites seulement. Une vue en retard sur le modele (une mise a jour distante
 * pas encore affichee) n'ecrase donc rien d'autre. A appeler dans
 * tree.transact.
 */
export function writeFromView(tree: ISharedTree, data: MindElixirData, req: WriteRequest): void {
  const root = tree.root
  const view = indexView(data.nodeData)
  const model = readModel(tree)
  const reorder = new Set<string>()
  const done = new Set<string>()

  const upsert = (id: string) => {
    if (done.has(id)) return
    done.add(id)
    const entry = view.get(id)!
    // Ancetres absents du modele (premiere modification d'une carte neuve,
    // ou ancetre supprime ailleurs) : on les ecrit aussi.
    if (entry.parent !== null && !model.nodes.has(entry.parent)) upsert(entry.parent)
    const n = entry.node
    let m = root.get(NODE_PREFIX + id)
    if (!isMap(m)) {
      m = root.set(NODE_PREFIX + id, {
        kind: 'map',
        entries: { parent: entry.parent, order: '', topic: { kind: 'text', delta: n.topic ? [{ insert: n.topic }] : [] } },
      }) as ITreeMap
      if (entry.parent !== null) reorder.add(entry.parent)
    } else {
      if (m.get('parent') !== entry.parent) {
        m.set('parent', entry.parent)
        m.set('order', '')
        if (entry.parent !== null) reorder.add(entry.parent)
      }
      const t = m.get('topic')
      const topic = n.topic ?? ''
      if (isText(t)) {
        const cur = t.toString()
        if (cur !== topic) t.applyDelta(topicDelta(cur, req.topicBase?.get(id) ?? cur, topic))
      } else {
        m.set('topic', { kind: 'text', delta: topic ? [{ insert: topic }] : [] })
      }
    }
    // Proprietes.
    const seen = new Set<string>()
    for (const [k, v] of Object.entries(n)) {
      if (NOT_PROPS.has(k) || v === undefined) continue
      seen.add(PROP_PREFIX + k)
      const json = JSON.stringify(v)
      if (m.get(PROP_PREFIX + k) !== json) m.set(PROP_PREFIX + k, json)
    }
    for (const k of m.keys()) {
      if (k.startsWith(PROP_PREFIX) && !seen.has(k)) m.delete(k)
    }
  }

  const remove = (id: string) => {
    if (!model.nodes.has(id)) return
    // Le noeud et tout ce qui est dessous dans le modele.
    const doomed = new Set([id])
    let grew = true
    while (grew) {
      grew = false
      for (const n of model.nodes.values()) {
        if (n.parent !== null && doomed.has(n.parent) && !doomed.has(n.id) && !view.has(n.id)) {
          doomed.add(n.id)
          grew = true
        }
      }
    }
    for (const d of doomed) root.delete(NODE_PREFIX + d)
  }

  for (const id of req.nodes ?? []) {
    if (view.has(id)) {
      upsert(id)
      // Un deplacement parmi les freres : il faut reordonner meme si le
      // parent n'a pas change.
      const p = view.get(id)!.parent
      if (p !== null) reorder.add(p)
    } else {
      remove(id)
    }
  }

  // Ordre des freres : on garde le plus de cles possible.
  for (const parent of reorder) {
    const kids = view.get(parent)?.node.children ?? []
    const maps = kids.map(k => root.get(NODE_PREFIX + k.id))
    const keys = maps.map(m => {
      if (!isMap(m) || m.get('parent') !== parent) return null
      const o = m.get('order')
      return typeof o === 'string' && o !== '' ? o : null
    })
    // Seuls les freres presents dans le modele sont reordonnes ; un frere de
    // la vue absent du modele (supprime ailleurs) n'est pas ressuscite ici.
    const present = maps.map((m, i) => (isMap(m) && m.get('parent') === parent ? i : -1)).filter(i => i >= 0)
    const sub = reorderKeys(present.map(i => keys[i]))
    for (const [j, key] of sub) (maps[present[j]] as ITreeMap).set('order', key)
  }

  const arrows = new Map((data.arrows ?? []).map(a => [a.id, a]))
  for (const id of req.arrows ?? []) {
    const a = arrows.get(id)
    if (a) {
      const json = JSON.stringify({ ...a, id: undefined })
      if (root.get(ARROW_PREFIX + id) !== json) root.set(ARROW_PREFIX + id, json)
    } else if (root.has(ARROW_PREFIX + id)) root.delete(ARROW_PREFIX + id)
  }
  const summaries = new Map((data.summaries ?? []).map(s => [s.id, s]))
  for (const id of req.summaries ?? []) {
    const s = summaries.get(id)
    if (s) {
      const json = JSON.stringify({ ...s, id: undefined })
      if (root.get(SUMMARY_PREFIX + id) !== json) root.set(SUMMARY_PREFIX + id, json)
    } else if (root.has(SUMMARY_PREFIX + id)) root.delete(SUMMARY_PREFIX + id)
  }
}

/** Ecrit toute la vue (migration d'un ancien fichier). N'efface rien. */
export function writeAll(tree: ISharedTree, data: MindElixirData): void {
  writeFromView(tree, data, {
    nodes: indexView(data.nodeData).keys(),
    arrows: (data.arrows ?? []).map(a => a.id),
    summaries: (data.summaries ?? []).map(s => s.id),
  })
}

// ── Operations mind-elixir -> ecritures ─────────────────────────────────

/** Forme minimale d'une operation mind-elixir (bus 'operation'). */
export interface MindOperation {
  name: string
  obj?: { id: string; children?: NodeObj[] }
  objs?: Array<{ id: string; children?: NodeObj[] }>
  toObj?: { id: string }
  origin?: unknown
}

function subtreeIds(n: { id: string; children?: NodeObj[] }, out: string[]): string[] {
  out.push(n.id)
  for (const c of n.children ?? []) subtreeIds(c, out)
  return out
}

/**
 * Ce qu'une operation touche. null : rien a ecrire (debut d'edition...).
 * Une operation inconnue rend tous les noeuds de la vue : on ecrit tout ce
 * qui differe, sans rien effacer.
 */
export function requestFor(op: MindOperation, data: MindElixirData): WriteRequest | null {
  const obj = op.obj
  switch (op.name) {
    case 'beginEdit':
      return null
    case 'finishEdit':
      return obj
        ? { nodes: [obj.id], topicBase: typeof op.origin === 'string' ? new Map([[obj.id, op.origin]]) : undefined }
        : null
    case 'reshapeNode':
    case 'moveUpNode':
    case 'moveDownNode':
      return obj ? { nodes: [obj.id] } : null
    case 'addChild':
    case 'insertSibling':
    case 'insertBefore':
    case 'insertParent':
    case 'copyNode':
    case 'removeNode':
      return obj ? { nodes: subtreeIds(obj, []) } : null
    case 'moveNodeIn':
    case 'moveNodeBefore':
    case 'moveNodeAfter':
      if (op.objs) return { nodes: op.objs.map(o => o.id) }
      return obj ? { nodes: [obj.id] } : null
    case 'copyNodes':
    case 'removeNodes':
      return { nodes: (op.objs ?? []).flatMap(o => subtreeIds(o, [])) }
    case 'createArrow':
    case 'removeArrow':
    case 'finishEditArrowLabel':
      return obj ? { arrows: [obj.id] } : null
    case 'createSummary':
    case 'removeSummary':
    case 'finishEditSummary':
      return obj ? { summaries: [obj.id] } : null
    default:
      return { nodes: indexView(data.nodeData).keys() }
  }
}

/** Le modele a-t-il au moins un noeud ? */
export function hasNodes(tree: ISharedTree): boolean {
  return tree.root.keys().some(k => k.startsWith(NODE_PREFIX))
}

/** Donnees d'une carte neuve : une racine au titre donne. */
export function emptyMap(title: string): MindElixirData {
  return { nodeData: { id: ROOT_ID, topic: title, children: [] } }
}

/** Ancien fichier .mm (JSON mind-elixir), ou null s'il n'en est pas un. */
export function parseLegacy(raw: string | null | undefined): MindElixirData | null {
  if (!raw || !raw.trim()) return null
  try {
    const data = JSON.parse(raw) as MindElixirData & { migratedToCrdt?: boolean }
    if (!data || typeof data !== 'object' || !data.nodeData || typeof data.nodeData.id !== 'string') return null
    if (data.migratedToCrdt) return null
    return data
  } catch {
    return null
  }
}
