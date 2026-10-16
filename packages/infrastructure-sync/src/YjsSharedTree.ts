// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Adaptateur Yjs -> ISharedTree (@savoire/plugin-api). Les plugins ne voient
// jamais Yjs. Voir docs/Architecture/plugin-crdt-api.md.
//
// Correspondance des noeuds :
//   carte   -> Y.Map
//   liste   -> Y.Array
//   texte   -> Y.Text, ou Y.XmlText sous un element
//   element -> Y.XmlElement (enfants : Y.XmlElement et Y.XmlText)
// La racine est la Y.Map 'tree' du Y.Doc du document : meme document, meme
// synchro que le texte ('codemirror'), sans rien changer aux profils.
//
// Pourquoi Y.XmlElement pour les elements, et pas une Y.Map {nom, attributs,
// enfants} : c'est le modele exact de y-prosemirror (nom, attributs,
// enfants ordonnes, texte avec formats). Un plugin qui reflete un Y.Doc
// prive Tiptap traduit alors noeud pour noeud, sans conversion de forme.
// Et la carte/liste/texte generiques couvrent tout le reste du JSON.
//
// Identite : l'id d'un noeud est l'id de son item Yjs (client:horloge), le
// meme chez tous les pairs. Une poignee par type Yjs (WeakMap), donc stable.
//
// Origine : transaction.local donne 'local' ou 'remote'. L'etiquette de
// transact() voyage dans l'origine de la transaction Yjs.
import * as Y from 'yjs'
import type {
  ChangeOrigin,
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
  TreeElementChild,
  TreeElementChildInit,
  TreeNode,
  TreeNodeInit,
  TreeValue,
  TreeValueInit,
} from '@savoire/plugin-api'

// Meme contournement que YjsCollaborativeText : TS 5.9 + moduleResolution
// bundler suit mal les types herites de Yjs. On type au plus juste a la main.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type YType = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type YEvent = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Y_ = Y as Record<string, any>

/** Origine Yjs des transactions de l'adaptateur : porte l'etiquette. */
class TreeOrigin {
  constructor(readonly tag: unknown) {}
}
const UNTAGGED = new TreeOrigin(undefined)

function isPrimitive(v: unknown): v is null | boolean | number | string {
  return v === null || typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string'
}

function checkInit(v: TreeValueInit): void {
  if (isPrimitive(v)) return
  const kind = (v as { kind?: unknown } | undefined)?.kind
  if (kind !== 'map' && kind !== 'list' && kind !== 'text' && kind !== 'element') {
    throw new Error(`arbre partage : valeur invalide (primitive ou { kind } attendu) : ${String(v)}`)
  }
}

function checkChildInit(v: TreeElementChildInit): void {
  if (v?.kind !== 'element' && v?.kind !== 'text') {
    throw new Error('arbre partage : un element n\'a que des enfants element ou texte')
  }
}

function cleanAttrs(a: unknown): TextAttributes | undefined {
  if (!a || typeof a !== 'object') return undefined
  return Object.keys(a).length > 0 ? { ...(a as TextAttributes) } : undefined
}

/** Delta de texte Yjs -> contrat (embeds ignores). */
function fromYTextDelta(delta: YType[]): RichTextDelta {
  const out: RichTextDelta = []
  for (const op of delta) {
    const attributes = cleanAttrs(op.attributes)
    if (typeof op.retain === 'number') out.push(attributes ? { retain: op.retain, attributes } : { retain: op.retain })
    else if (typeof op.delete === 'number') out.push({ delete: op.delete })
    else if (typeof op.insert === 'string') out.push(attributes ? { insert: op.insert, attributes } : { insert: op.insert })
  }
  return out
}

export class YjsSharedTree implements ISharedTree {
  readonly root: ITreeMap
  private readonly handles = new WeakMap<object, TreeNode>()

  constructor(private readonly ydoc: YType, rootName = 'tree') {
    this.root = this.wrap(ydoc.getMap(rootName)) as ITreeMap
  }

  transact(fn: () => void, tag?: unknown): void {
    this.ydoc.transact(fn, tag === undefined ? UNTAGGED : new TreeOrigin(tag))
  }

  onChange(cb: (changes: TreeChange[], info: TreeChangeInfo) => void): () => void {
    return this.root.observeDeep(cb)
  }

  // ── Interne ────────────────────────────────────────────────────────────

  /** Une transaction ; dans un transact() en cours, la rejoint. */
  run<T>(fn: () => T): T {
    let out!: T
    this.ydoc.transact(() => { out = fn() }, UNTAGGED)
    return out
  }

  wrap(t: YType): TreeNode {
    let h = this.handles.get(t)
    if (h) return h
    // XmlText herite de Text : le tester en premier ne change rien ici, les
    // deux donnent un texte.
    if (t instanceof Y_.XmlElement) h = new YElement(this, t)
    else if (t instanceof Y_.Text) h = new YText(this, t)
    else if (t instanceof Y_.Array) h = new YList(this, t)
    else if (t instanceof Y_.Map) h = new YMap(this, t)
    else throw new Error('arbre partage : type Yjs inattendu')
    this.handles.set(t, h)
    return h
  }

  toValue(v: unknown): TreeValue {
    if (v instanceof Y_.AbstractType) return this.wrap(v)
    return isPrimitive(v) ? v : null
  }

  info(tr: YType): TreeChangeInfo {
    const origin: ChangeOrigin = tr.local ? 'local' : 'remote'
    if (origin === 'local' && tr.origin instanceof TreeOrigin && tr.origin.tag !== undefined) {
      return { origin, tag: tr.origin.tag }
    }
    return { origin }
  }

  toChange(e: YEvent): TreeChange | null {
    const target = this.wrap(e.target)
    switch (target.kind) {
      case 'map':
        return { kind: 'map', target, keys: [...(e.keysChanged as Set<string>)] }
      case 'list':
        return { kind: 'list', target, delta: this.listDelta(e.delta) }
      case 'text':
        return { kind: 'text', target, delta: fromYTextDelta(e.delta) }
      case 'element':
        return {
          kind: 'element',
          target,
          attributes: [...(e.attributesChanged as Set<string>)],
          children: this.listDelta(e.delta) as ListDelta<TreeElementChild>,
        }
    }
  }

  private listDelta(delta: YType[]): ListDelta {
    const out: ListDelta = []
    for (const op of delta) {
      if (typeof op.retain === 'number') out.push({ retain: op.retain })
      else if (typeof op.delete === 'number') out.push({ delete: op.delete })
      else if (Array.isArray(op.insert)) out.push({ insert: op.insert.map((v: unknown) => this.toValue(v)) })
    }
    return out
  }

  /** Type Yjs vide pour une description. Rempli APRES insertion (fill). */
  empty(init: TreeNodeInit, inElement: boolean): YType {
    switch (init.kind) {
      case 'map': return new Y_.Map()
      case 'list': return new Y_.Array()
      case 'text': return inElement ? new Y_.XmlText() : new Y_.Text()
      case 'element': return new Y_.XmlElement(init.name)
    }
  }

  /** Remplit un type deja insere (donc integre au document). */
  fill(t: YType, init: TreeNodeInit): void {
    const h = this.wrap(t)
    switch (init.kind) {
      case 'map':
        for (const [k, v] of Object.entries(init.entries ?? {})) (h as ITreeMap).set(k, v)
        break
      case 'list':
        if (init.items?.length) (h as ITreeList).insert(0, init.items)
        break
      case 'text':
        if (init.delta?.length) (h as ITreeText).applyDelta(init.delta)
        break
      case 'element':
        for (const [k, v] of Object.entries(init.attributes ?? {})) (h as ITreeElement).setAttribute(k, v)
        if (init.children?.length) (h as ITreeElement).insert(0, init.children)
        break
    }
  }
}

// ── Poignees ───────────────────────────────────────────────────────────────

abstract class YNode<C extends TreeChange> {
  constructor(protected readonly tree: YjsSharedTree, protected readonly y: YType) {}

  get id(): string {
    const item = this.y._item
    return item ? `${item.id.client}:${item.id.clock}` : 'root'
  }

  get parent(): TreeNode | null {
    const item = this.y._item
    return item && item.parent ? this.tree.wrap(item.parent) : null
  }

  get deleted(): boolean {
    let item = this.y._item
    // Supprime lui-meme, ou dans un sous-arbre supprime.
    while (item) {
      if (item.deleted) return true
      item = item.parent?._item
    }
    return false
  }

  abstract toJSON(): JsonValue

  observe(cb: (change: C, info: TreeChangeInfo) => void): () => void {
    const handler = (e: YEvent, tr: YType): void => {
      const change = this.tree.toChange(e)
      if (change) cb(change as C, this.tree.info(tr))
    }
    this.y.observe(handler)
    return () => this.y.unobserve(handler)
  }

  observeDeep(cb: (changes: TreeChange[], info: TreeChangeInfo) => void): () => void {
    const handler = (events: YEvent[], tr: YType): void => {
      const changes = events.map(e => this.tree.toChange(e)).filter((c): c is TreeChange => c !== null)
      if (changes.length > 0) cb(changes, this.tree.info(tr))
    }
    this.y.observeDeep(handler)
    return () => this.y.unobserveDeep(handler)
  }
}

function jsonOf(v: TreeValue): JsonValue {
  return v !== null && typeof v === 'object' ? v.toJSON() : v
}

class YMap extends YNode<import('@savoire/plugin-api').TreeMapChange> implements ITreeMap {
  readonly kind = 'map' as const

  get size(): number { return this.y.size }
  get(key: string): TreeValue | undefined {
    return this.y.has(key) ? this.tree.toValue(this.y.get(key)) : undefined
  }
  has(key: string): boolean { return this.y.has(key) }
  keys(): string[] { return [...this.y.keys()] }

  set(key: string, value: TreeValueInit): TreeValue {
    checkInit(value)
    if (this.deleted) return null
    return this.tree.run(() => {
      if (isPrimitive(value)) { this.y.set(key, value); return value }
      const t = this.tree.empty(value, false)
      this.y.set(key, t)
      this.tree.fill(t, value)
      return this.tree.wrap(t)
    })
  }

  delete(key: string): void {
    if (!this.deleted) this.tree.run(() => this.y.delete(key))
  }

  toJSON(): JsonValue {
    const out: Record<string, JsonValue> = {}
    for (const k of this.keys()) out[k] = jsonOf(this.get(k)!)
    return out
  }
}

class YList extends YNode<import('@savoire/plugin-api').TreeListChange> implements ITreeList {
  readonly kind = 'list' as const

  get length(): number { return this.y.length }
  get(index: number): TreeValue | undefined {
    return index >= 0 && index < this.y.length ? this.tree.toValue(this.y.get(index)) : undefined
  }
  toArray(): TreeValue[] { return (this.y.toArray() as unknown[]).map(v => this.tree.toValue(v)) }

  insert(index: number, values: TreeValueInit[]): TreeValue[] {
    values.forEach(checkInit)
    if (this.deleted || values.length === 0) return []
    return this.tree.run(() => {
      const ys = values.map(v => isPrimitive(v) ? v : this.tree.empty(v, false))
      this.y.insert(index, ys)
      return values.map((v, i) => {
        if (isPrimitive(v)) return v
        this.tree.fill(ys[i], v)
        return this.tree.wrap(ys[i])
      })
    })
  }

  push(values: TreeValueInit[]): TreeValue[] { return this.insert(this.length, values) }

  delete(index: number, length = 1): void {
    if (!this.deleted && length > 0) this.tree.run(() => this.y.delete(index, length))
  }

  toJSON(): JsonValue { return this.toArray().map(jsonOf) }
}

class YText extends YNode<import('@savoire/plugin-api').TreeTextChange> implements ITreeText {
  readonly kind = 'text' as const

  get length(): number { return this.y.length }
  toString(): string {
    // Y.XmlText.toString() rend du XML (<bold>...</bold>) : passer par le delta.
    if (this.y instanceof Y_.XmlText) {
      return (this.y.toDelta() as YType[]).map(op => typeof op.insert === 'string' ? op.insert : '').join('')
    }
    return this.y.toString()
  }
  toDelta(): RichTextDelta { return fromYTextDelta(this.y.toDelta()) }

  insert(index: number, text: string, attributes?: TextAttributes): void {
    // Des attributs explicites (meme vides) : sinon Yjs reprend le format du
    // caractere precedent, ce que le contrat ne veut pas.
    if (text && !this.deleted) this.tree.run(() => this.y.insert(index, text, { ...(attributes ?? {}) }))
  }

  delete(index: number, length: number): void {
    if (length > 0 && !this.deleted) this.tree.run(() => this.y.delete(index, length))
  }

  format(index: number, length: number, attributes: TextAttributes): void {
    if (length > 0 && !this.deleted) this.tree.run(() => this.y.format(index, length, attributes))
  }

  applyDelta(delta: RichTextDelta): void {
    if (this.deleted) return
    // A la main plutot que Y.Text.applyDelta : son option « sanitize »
    // retire un saut de ligne final.
    this.tree.run(() => {
      let pos = 0
      for (const op of delta) {
        if ('retain' in op) {
          if (op.attributes && op.retain > 0) this.y.format(pos, op.retain, op.attributes)
          pos += op.retain
        } else if ('delete' in op) {
          if (op.delete > 0) this.y.delete(pos, op.delete)
        } else if (op.insert) {
          this.y.insert(pos, op.insert, { ...(op.attributes ?? {}) })
          pos += op.insert.length
        }
      }
    })
  }

  toJSON(): JsonValue { return this.toString() }
}

class YElement extends YNode<import('@savoire/plugin-api').TreeElementChange> implements ITreeElement {
  readonly kind = 'element' as const

  get name(): string { return this.y.nodeName }

  getAttribute(name: string): JsonValue | undefined {
    const v = this.y.getAttribute(name)
    return v === undefined ? undefined : v as JsonValue
  }
  getAttributes(): Record<string, JsonValue> { return { ...this.y.getAttributes() } }

  setAttribute(name: string, value: JsonValue): void {
    if (!this.deleted) this.tree.run(() => this.y.setAttribute(name, value))
  }
  removeAttribute(name: string): void {
    if (!this.deleted) this.tree.run(() => this.y.removeAttribute(name))
  }

  get length(): number { return this.y.length }
  get(index: number): TreeElementChild | undefined {
    return index >= 0 && index < this.y.length ? this.tree.wrap(this.y.get(index)) as TreeElementChild : undefined
  }
  toArray(): TreeElementChild[] {
    return (this.y.toArray() as YType[]).map(t => this.tree.wrap(t) as TreeElementChild)
  }

  insert(index: number, children: TreeElementChildInit[]): TreeElementChild[] {
    children.forEach(checkChildInit)
    if (this.deleted || children.length === 0) return []
    return this.tree.run(() => {
      const ys = children.map(c => this.tree.empty(c, true))
      this.y.insert(index, ys)
      return children.map((c, i) => {
        this.tree.fill(ys[i], c)
        return this.tree.wrap(ys[i]) as TreeElementChild
      })
    })
  }

  push(children: TreeElementChildInit[]): TreeElementChild[] { return this.insert(this.length, children) }

  delete(index: number, length = 1): void {
    if (!this.deleted && length > 0) this.tree.run(() => this.y.delete(index, length))
  }

  toJSON(): JsonValue {
    return {
      name: this.name,
      attributes: this.getAttributes(),
      children: this.toArray().map(c => c.toJSON()),
    }
  }
}
