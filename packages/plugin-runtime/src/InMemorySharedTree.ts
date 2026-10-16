// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Implementation de reference de ISharedTree, en memoire, sans CRDT. Sert
// aux tests des plugins. Deux arbres relies par link() simulent deux
// membres : chaque transaction locale est rejouee chez l'autre comme un lot
// distant, dans l'ordre (sans fusion concurrente, ce qui suffit pour des
// tests deterministes). Les ids des noeuds voyagent avec les operations :
// un noeud a le meme id chez les deux membres.
import type {
  ISharedTree,
  ITreeElement,
  ITreeList,
  ITreeMap,
  ITreeText,
  JsonValue,
  ListDelta,
  RichTextDelta,
  TextAttributes,
  TreeChange,
  TreeChangeInfo,
  TreeElementChange,
  TreeElementChild,
  TreeElementChildInit,
  TreeListChange,
  TreeMapChange,
  TreeNode,
  TreeNodeInit,
  TreePrimitive,
  TreeTextChange,
  TreeValue,
  TreeValueInit,
} from '@savoire/plugin-api'

// ── Instantanes : un noeud a creer, avec ses ids ──────────────────────────

type Snap =
  | TreePrimitive
  | { kind: 'map'; id: string; entries: Record<string, Snap> }
  | { kind: 'list'; id: string; items: Snap[] }
  | { kind: 'text'; id: string; delta: RichTextDelta }
  | { kind: 'element'; id: string; name: string; attributes: Record<string, JsonValue>; children: Snap[] }

type Op =
  | { op: 'mapSet'; id: string; key: string; value: Snap }
  | { op: 'mapDel'; id: string; key: string }
  | { op: 'listIns'; id: string; index: number; values: Snap[] }
  | { op: 'listDel'; id: string; index: number; length: number }
  | { op: 'text'; id: string; delta: RichTextDelta }
  | { op: 'attr'; id: string; key: string; value?: JsonValue }

interface Tx {
  ops: Op[]
  changes: TreeChange[]
  /** Noeuds crees dans cette transaction : pas de changement propre. */
  created: Set<MemNode>
  info: TreeChangeInfo
}

function isPrimitive(v: unknown): v is TreePrimitive {
  return v === null || typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string'
}

function clone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v)) as T
}

let treeCounter = 0

export class InMemorySharedTree implements ISharedTree {
  readonly root: ITreeMap
  private readonly instance = `m${++treeCounter}`
  private counter = 0
  private readonly nodes = new Map<string, MemNode>()
  private readonly peers = new Set<InMemorySharedTree>()
  private tx: Tx | null = null

  constructor() {
    this.root = new MemMap(this, 'root', null)
  }

  /** Relie deux arbres : chacun recoit les transactions de l'autre. */
  static link(a: InMemorySharedTree, b: InMemorySharedTree): void {
    a.peers.add(b)
    b.peers.add(a)
  }

  transact(fn: () => void, tag?: unknown): void {
    this.within({ origin: 'local', ...(tag !== undefined ? { tag } : {}) }, fn)
  }

  onChange(cb: (changes: TreeChange[], info: TreeChangeInfo) => void): () => void {
    return this.root.observeDeep(cb)
  }

  // ── Interne ────────────────────────────────────────────────────────────

  register(node: MemNode): void { this.nodes.set(node.id, node) }

  /** Applique une operation dans une transaction (locale si aucune en cours). */
  apply(op: Op): void {
    this.within({ origin: 'local' }, () => {
      const tx = this.tx!
      if (tx.info.origin === 'local') tx.ops.push(op)
      this.nodes.get(op.id)?.applyOp(op, tx)
    })
  }

  snap(init: TreeValueInit): Snap {
    if (isPrimitive(init)) return init
    const id = `${this.instance}:${++this.counter}`
    switch ((init as TreeNodeInit | undefined)?.kind) {
      case 'map': {
        const i = init as Extract<TreeNodeInit, { kind: 'map' }>
        const entries: Record<string, Snap> = {}
        for (const [k, v] of Object.entries(i.entries ?? {})) entries[k] = this.snap(v)
        return { kind: 'map', id, entries }
      }
      case 'list':
        return { kind: 'list', id, items: ((init as Extract<TreeNodeInit, { kind: 'list' }>).items ?? []).map(v => this.snap(v)) }
      case 'text':
        return { kind: 'text', id, delta: clone((init as Extract<TreeNodeInit, { kind: 'text' }>).delta ?? []) }
      case 'element': {
        const i = init as Extract<TreeNodeInit, { kind: 'element' }>
        return {
          kind: 'element', id, name: i.name, attributes: clone(i.attributes ?? {}),
          children: (i.children ?? []).map(c => this.snapChild(c)),
        }
      }
      default:
        throw new Error(`arbre partage : valeur invalide (primitive ou { kind } attendu) : ${String(init)}`)
    }
  }

  snapChild(init: TreeElementChildInit): Snap {
    if (init?.kind !== 'element' && init?.kind !== 'text') {
      throw new Error('arbre partage : un element n\'a que des enfants element ou texte')
    }
    return this.snap(init)
  }

  build(s: Snap, parent: MemNode, tx: Tx): TreeValue {
    if (isPrimitive(s)) return s
    let node: MemNode
    switch (s.kind) {
      case 'map': {
        const m = new MemMap(this, s.id, parent)
        for (const [k, v] of Object.entries(s.entries)) m.entries.set(k, this.build(v, m, tx))
        node = m
        break
      }
      case 'list': {
        const l = new MemList(this, s.id, parent)
        l.items = s.items.map(v => this.build(v, l, tx))
        node = l
        break
      }
      case 'text': {
        const t = new MemText(this, s.id, parent)
        t.chars = applyRich([], s.delta)
        node = t
        break
      }
      case 'element': {
        const e = new MemElement(this, s.id, parent, s.name)
        for (const [k, v] of Object.entries(s.attributes)) e.attrs.set(k, v)
        e.items = s.children.map(c => this.build(c, e, tx))
        node = e
        break
      }
    }
    tx.created.add(node)
    return node as unknown as TreeNode
  }

  nodeOf(id: string): MemNode | undefined { return this.nodes.get(id) }

  private within(info: TreeChangeInfo, fn: () => void): void {
    if (this.tx) { fn(); return }
    const tx: Tx = { ops: [], changes: [], created: new Set(), info }
    this.tx = tx
    try {
      fn()
    } finally {
      this.tx = null
      this.emit(tx)
      if (tx.info.origin === 'local' && tx.ops.length > 0) {
        for (const peer of this.peers) peer.receive(tx.ops)
      }
    }
  }

  private receive(ops: Op[]): void {
    this.within({ origin: 'remote' }, () => {
      const tx = this.tx!
      for (const op of clone(ops)) this.nodes.get(op.id)?.applyOp(op, tx)
    })
  }

  private emit(tx: Tx): void {
    if (tx.changes.length === 0) return
    const deep = new Map<MemNode, TreeChange[]>()
    for (const c of tx.changes) {
      for (let n: MemNode | null = c.target as unknown as MemNode; n; n = n.parentNode) {
        const list = deep.get(n) ?? []
        list.push(c)
        deep.set(n, list)
      }
    }
    for (const [node, changes] of deep) {
      for (const c of changes) {
        if ((c.target as unknown as MemNode) === node) for (const cb of [...node.observers]) cb(c, tx.info)
      }
      for (const cb of [...node.deepObservers]) cb(changes, tx.info)
    }
  }
}

// ── Texte riche : un caractere = une unite UTF-16 + ses attributs ─────────

interface Char { ch: string; attrs: TextAttributes }

function mergeAttrs(base: TextAttributes, patch: TextAttributes): TextAttributes {
  const out = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k]
    else out[k] = clone(v)
  }
  return out
}

function applyRich(chars: Char[], delta: RichTextDelta): Char[] {
  const out: Char[] = []
  let pos = 0
  for (const op of delta) {
    if ('retain' in op) {
      for (const c of chars.slice(pos, pos + op.retain)) {
        out.push(op.attributes ? { ch: c.ch, attrs: mergeAttrs(c.attrs, op.attributes) } : c)
      }
      pos += op.retain
    } else if ('delete' in op) {
      pos += op.delete
    } else {
      const attrs = mergeAttrs({}, op.attributes ?? {})
      for (const ch of op.insert) for (let i = 0; i < ch.length; i++) out.push({ ch: ch[i], attrs })
    }
  }
  return out.concat(chars.slice(pos))
}

function sameAttrs(a: TextAttributes, b: TextAttributes): boolean {
  const ka = Object.keys(a).sort()
  const kb = Object.keys(b).sort()
  return JSON.stringify(ka) === JSON.stringify(kb) && ka.every(k => JSON.stringify(a[k]) === JSON.stringify(b[k]))
}

function compact(delta: RichTextDelta): RichTextDelta {
  return delta.filter(op =>
    'retain' in op ? op.retain > 0 : 'delete' in op ? op.delete > 0 : op.insert.length > 0)
}

// ── Noeuds ─────────────────────────────────────────────────────────────────

type AnyChange = TreeMapChange | TreeListChange | TreeTextChange | TreeElementChange

abstract class MemNode {
  readonly observers = new Set<(c: AnyChange, info: TreeChangeInfo) => void>()
  readonly deepObservers = new Set<(c: TreeChange[], info: TreeChangeInfo) => void>()
  private removed = false

  constructor(protected readonly tree: InMemorySharedTree, readonly id: string, readonly parentNode: MemNode | null) {
    tree.register(this)
  }

  get parent(): TreeNode | null { return this.parentNode as unknown as TreeNode | null }

  get deleted(): boolean {
    for (let n: MemNode | null = this; n; n = n.parentNode) if (n.removed) return true
    return false
  }

  markDeleted(): void { this.removed = true }

  abstract applyOp(op: Op, tx: Tx): void
  abstract toJSON(): JsonValue

  observe(cb: (c: never, info: TreeChangeInfo) => void): () => void {
    const f = cb as unknown as (c: AnyChange, info: TreeChangeInfo) => void
    this.observers.add(f)
    return () => { this.observers.delete(f) }
  }

  observeDeep(cb: (c: TreeChange[], info: TreeChangeInfo) => void): () => void {
    this.deepObservers.add(cb)
    return () => { this.deepObservers.delete(cb) }
  }

  /** Enregistre un changement, sauf pour un noeud ne dans cette transaction. */
  protected record(tx: Tx, change: TreeChange): void {
    if (!tx.created.has(this) && !this.deleted) tx.changes.push(change)
  }
}

function dropValue(v: TreeValue | undefined): void {
  if (v !== null && typeof v === 'object') (v as unknown as MemNode).markDeleted()
}

function jsonOf(v: TreeValue): JsonValue {
  return v !== null && typeof v === 'object' ? v.toJSON() : v
}

class MemMap extends MemNode implements ITreeMap {
  readonly kind = 'map' as const
  readonly entries = new Map<string, TreeValue>()

  get size(): number { return this.entries.size }
  get(key: string): TreeValue | undefined { return this.entries.get(key) }
  has(key: string): boolean { return this.entries.has(key) }
  keys(): string[] { return [...this.entries.keys()] }

  set(key: string, value: TreeValueInit): TreeValue {
    const s = this.tree.snap(value)
    if (this.deleted) return null
    this.tree.apply({ op: 'mapSet', id: this.id, key, value: s })
    return this.entries.get(key) ?? null
  }

  delete(key: string): void {
    if (!this.deleted && this.entries.has(key)) this.tree.apply({ op: 'mapDel', id: this.id, key })
  }

  applyOp(op: Op, tx: Tx): void {
    if (op.op === 'mapSet') {
      dropValue(this.entries.get(op.key))
      this.entries.set(op.key, this.tree.build(op.value, this, tx))
    } else if (op.op === 'mapDel') {
      dropValue(this.entries.get(op.key))
      this.entries.delete(op.key)
    } else return
    this.record(tx, { kind: 'map', target: this, keys: [op.key] })
  }

  toJSON(): JsonValue {
    const out: Record<string, JsonValue> = {}
    for (const [k, v] of this.entries) out[k] = jsonOf(v)
    return out
  }
}

/** Partie commune des listes et des enfants d'element. */
abstract class MemSeq extends MemNode {
  items: TreeValue[] = []

  get length(): number { return this.items.length }

  protected insertSnaps(index: number, snaps: Snap[]): TreeValue[] {
    if (this.deleted || snaps.length === 0) return []
    const at = Math.max(0, Math.min(index, this.items.length))
    this.tree.apply({ op: 'listIns', id: this.id, index: at, values: snaps })
    return this.items.slice(at, at + snaps.length)
  }

  delete(index: number, length = 1): void {
    if (this.deleted || length <= 0) return
    this.tree.apply({ op: 'listDel', id: this.id, index, length })
  }

  protected applySeq(op: Op, tx: Tx): ListDelta | null {
    if (op.op === 'listIns') {
      const values = op.values.map(v => this.tree.build(v, this, tx))
      this.items.splice(op.index, 0, ...values)
      return [...(op.index > 0 ? [{ retain: op.index }] : []), { insert: values }]
    }
    if (op.op === 'listDel') {
      const removed = this.items.splice(op.index, op.length)
      removed.forEach(dropValue)
      if (removed.length === 0) return null
      return [...(op.index > 0 ? [{ retain: op.index }] : []), { delete: removed.length }]
    }
    return null
  }
}

class MemList extends MemSeq implements ITreeList {
  readonly kind = 'list' as const

  get(index: number): TreeValue | undefined { return this.items[index] }
  toArray(): TreeValue[] { return [...this.items] }
  insert(index: number, values: TreeValueInit[]): TreeValue[] {
    return this.insertSnaps(index, values.map(v => this.tree.snap(v)))
  }
  push(values: TreeValueInit[]): TreeValue[] { return this.insert(this.length, values) }

  applyOp(op: Op, tx: Tx): void {
    const delta = this.applySeq(op, tx)
    if (delta) this.record(tx, { kind: 'list', target: this, delta })
  }

  toJSON(): JsonValue { return this.items.map(jsonOf) }
}

class MemElement extends MemSeq implements ITreeElement {
  readonly kind = 'element' as const
  readonly attrs = new Map<string, JsonValue>()

  constructor(tree: InMemorySharedTree, id: string, parent: MemNode, readonly name: string) {
    super(tree, id, parent)
  }

  getAttribute(name: string): JsonValue | undefined { return clone(this.attrs.get(name)) }
  getAttributes(): Record<string, JsonValue> { return clone(Object.fromEntries(this.attrs)) }
  setAttribute(name: string, value: JsonValue): void {
    if (!this.deleted) this.tree.apply({ op: 'attr', id: this.id, key: name, value: clone(value) })
  }
  removeAttribute(name: string): void {
    if (!this.deleted && this.attrs.has(name)) this.tree.apply({ op: 'attr', id: this.id, key: name })
  }

  get(index: number): TreeElementChild | undefined { return this.items[index] as TreeElementChild | undefined }
  toArray(): TreeElementChild[] { return [...this.items] as TreeElementChild[] }
  insert(index: number, children: TreeElementChildInit[]): TreeElementChild[] {
    return this.insertSnaps(index, children.map(c => this.tree.snapChild(c))) as TreeElementChild[]
  }
  push(children: TreeElementChildInit[]): TreeElementChild[] { return this.insert(this.length, children) }

  applyOp(op: Op, tx: Tx): void {
    if (op.op === 'attr') {
      if (op.value === undefined) this.attrs.delete(op.key)
      else this.attrs.set(op.key, op.value)
      this.record(tx, { kind: 'element', target: this, attributes: [op.key], children: [] })
      return
    }
    const delta = this.applySeq(op, tx)
    if (delta) this.record(tx, { kind: 'element', target: this, attributes: [], children: delta as ListDelta<TreeElementChild> })
  }

  toJSON(): JsonValue {
    return { name: this.name, attributes: this.getAttributes(), children: this.items.map(jsonOf) }
  }
}

class MemText extends MemNode implements ITreeText {
  readonly kind = 'text' as const
  chars: Char[] = []

  get length(): number { return this.chars.length }
  toString(): string { return this.chars.map(c => c.ch).join('') }

  toDelta(): RichTextDelta {
    const out: { insert: string; attributes?: TextAttributes }[] = []
    for (const c of this.chars) {
      const last = out[out.length - 1]
      if (last && sameAttrs(last.attributes ?? {}, c.attrs)) last.insert += c.ch
      else out.push(Object.keys(c.attrs).length ? { insert: c.ch, attributes: clone(c.attrs) } : { insert: c.ch })
    }
    return out
  }

  insert(index: number, text: string, attributes?: TextAttributes): void {
    if (text) this.applyDelta([{ retain: index }, attributes ? { insert: text, attributes } : { insert: text }])
  }
  delete(index: number, length: number): void {
    if (length > 0) this.applyDelta([{ retain: index }, { delete: length }])
  }
  format(index: number, length: number, attributes: TextAttributes): void {
    if (length > 0) this.applyDelta([{ retain: index }, { retain: length, attributes }])
  }
  applyDelta(delta: RichTextDelta): void {
    const d = compact(clone(delta))
    if (!this.deleted && d.length > 0) this.tree.apply({ op: 'text', id: this.id, delta: d })
  }

  applyOp(op: Op, tx: Tx): void {
    if (op.op !== 'text') return
    this.chars = applyRich(this.chars, op.delta)
    this.record(tx, { kind: 'text', target: this, delta: op.delta })
  }

  toJSON(): JsonValue { return this.toString() }
}

