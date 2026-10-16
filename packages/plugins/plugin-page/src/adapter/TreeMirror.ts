// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Miroir entre le Y.Doc PRIVE de la page et l'arbre partage du document.
//
// Tiptap est lie au Y.Doc prive par y-prosemirror : c'est un detail interne
// du plugin. Le contenu partage, lui, est l'arbre (ISharedTree), qui
// n'expose aucune bibliotheque CRDT. Ce module recopie dans les deux sens :
//
//   Y.Doc (geste local, annuler...) -> operations de l'arbre, sous NOTRE
//     etiquette de transaction ; les lots de l'arbre qui la portent sont
//     notre propre echo et sont ignores.
//   arbre (lot distant) -> Y.Doc, sous NOTRE origine Yjs ; les evenements
//     Yjs de cette origine sont notre propre echo et sont ignores.
//
// Chaque noeud du Y.Doc est lie a son noeud de l'arbre (XmlElement <->
// element, XmlText <-> texte) : les poignees de l'arbre sont stables, on
// s'en sert comme cles. Sous la cle 'doc' de la racine : l'element 'doc'.
//
// Rien n'est ecrit dans l'arbre a l'ouverture : seulement quand le Y.Doc
// change par un geste de la personne.
import * as Y from 'yjs'
import type {
  ISharedTree, ITreeElement, ITreeText, TreeChange, TreeChangeInfo, TreeElementChild,
  TreeElementChildInit, TreeElementInit,
} from '@savoire/plugin-api'
import {
  fragmentToInit, insertInitsIntoY, treeDeltaToY, yChildren, yDeltaToTree, yToInit,
} from './convert'

/** Cle de la racine de l'arbre sous laquelle vit la page. */
export const DOC_KEY = 'doc'

type YNode = Y.XmlFragment | Y.XmlElement | Y.XmlText
type TreeNode = ITreeElement | ITreeText

/** Description d'un noeud vivant de l'arbre. */
export function treeToInit(node: TreeElementChild): TreeElementChildInit {
  if (node.kind === 'text') return { kind: 'text', delta: node.toDelta() }
  const attributes = node.getAttributes()
  return {
    kind: 'element',
    name: node.name,
    ...(Object.keys(attributes).length ? { attributes } : {}),
    children: node.toArray().map(treeToInit),
  }
}

export class TreeMirror {
  private readonly toTree = new Map<YNode, TreeNode>()
  private readonly toY = new Map<TreeNode, YNode>()
  /** Etiquette de nos transactions dans l'arbre. */
  private readonly tag = { mirror: 'plugin-page' }
  private readonly unsubs: (() => void)[] = []

  constructor(
    private readonly fragment: Y.XmlFragment,
    private readonly tree: ISharedTree,
  ) {}

  /** Demarre la recopie. Ne touche pas a l'arbre. */
  attach(): void {
    const doc = this.treeDoc()
    if (doc) this.loadFromTree(doc)
    const onY = (events: Y.YEvent<Y.AbstractType<unknown>>[], tr: Y.Transaction) => {
      if (tr.origin === this) return
      this.pushToTree(events)
    }
    this.fragment.observeDeep(onY)
    this.unsubs.push(() => this.fragment.unobserveDeep(onY))
    this.unsubs.push(this.tree.onChange((changes, info) => this.pullFromTree(changes, info)))
  }

  detach(): void {
    for (const u of this.unsubs.splice(0)) u()
    this.toTree.clear()
    this.toY.clear()
  }

  // ── Liaison des noeuds ─────────────────────────────────────────────────

  private bind(y: YNode, t: TreeNode): void {
    this.toTree.set(y, t)
    this.toY.set(t, y)
  }

  /** Lie deux sous-arbres de meme forme, noeud a noeud. */
  private bindDeep(y: YNode, t: TreeNode): void {
    this.bind(y, t)
    if (y instanceof Y.XmlText || t.kind !== 'element') return
    const ys = yChildren(y)
    const ts = t.toArray()
    for (let i = 0; i < Math.min(ys.length, ts.length); i++) this.bindDeep(ys[i], ts[i])
  }

  private treeDoc(): ITreeElement | null {
    const v = this.tree.root.get(DOC_KEY)
    return typeof v === 'object' && v !== null && v.kind === 'element' ? v : null
  }

  // ── Arbre -> Y.Doc ─────────────────────────────────────────────────────

  /** Remplace le contenu du Y.Doc par celui de l'arbre (ouverture, 'doc' remplace). */
  private loadFromTree(doc: ITreeElement): void {
    this.toTree.clear()
    this.toY.clear()
    this.fragment.doc!.transact(() => {
      if (this.fragment.length) this.fragment.delete(0, this.fragment.length)
      insertInitsIntoY(this.fragment, 0, doc.toArray().map(treeToInit))
    }, this)
    this.bindDeep(this.fragment, doc)
  }

  private pullFromTree(changes: TreeChange[], info: TreeChangeInfo): void {
    if (info.tag === this.tag) return
    let reload = false
    this.fragment.doc!.transact(() => {
      for (const change of changes) {
        if (change.target.deleted) continue
        if (change.kind === 'map') {
          if (change.target === this.tree.root && change.keys.includes(DOC_KEY)) reload = true
          continue
        }
        if (reload || change.kind === 'list') continue
        const y = this.toY.get(change.target)
        if (!y) { reload = true; continue }
        if (change.kind === 'text') {
          if (y instanceof Y.XmlText) y.applyDelta(treeDeltaToY(change.delta))
          else reload = true
          continue
        }
        if (y instanceof Y.XmlText) { reload = true; continue }
        if (y instanceof Y.XmlElement) {
          for (const name of change.attributes) {
            const v = change.target.getAttribute(name)
            if (v === undefined || v === null) y.removeAttribute(name)
            else y.setAttribute(name, v as never)
          }
        }
        let index = 0
        for (const op of change.children) {
          if ('retain' in op) index += op.retain
          else if ('delete' in op) y.delete(index, op.delete)
          else {
            const created = insertInitsIntoY(y, index, op.insert.map(treeToInit))
            created.forEach((node, i) => this.bindDeep(node, op.insert[i]))
            index += op.insert.length
          }
        }
      }
    }, this)
    if (reload) {
      // Cas imprevu (noeud inconnu, 'doc' remplace) : on repart de l'arbre.
      const doc = this.treeDoc()
      if (doc) this.loadFromTree(doc)
      else this.clearY()
    }
  }

  private clearY(): void {
    this.toTree.clear()
    this.toY.clear()
    if (!this.fragment.length) return
    this.fragment.doc!.transact(() => this.fragment.delete(0, this.fragment.length), this)
  }

  // ── Y.Doc -> arbre ─────────────────────────────────────────────────────

  private pushToTree(events: Y.YEvent<Y.AbstractType<unknown>>[]): void {
    this.tree.transact(() => {
      const doc = this.treeDoc()
      if (!doc || !this.toTree.has(this.fragment)) {
        // Premiere ecriture d'une page vide : on cree l'element 'doc'.
        this.writeWholeDoc()
        return
      }
      for (const event of events) {
        const t = this.toTree.get(event.target as YNode)
        if (!t || t.deleted) { this.writeWholeDoc(); return }
        if (event.target instanceof Y.XmlText) {
          if (t.kind !== 'text') { this.writeWholeDoc(); return }
          const delta = yDeltaToTree(event.delta as Record<string, unknown>[])
          if (delta.length) t.applyDelta(delta)
          continue
        }
        if (t.kind !== 'element') { this.writeWholeDoc(); return }
        if (event.target instanceof Y.XmlElement) {
          for (const name of (event as Y.YXmlEvent).attributesChanged) {
            const v = event.target.getAttribute(name)
            if (v === undefined || v === null) t.removeAttribute(name)
            else t.setAttribute(name, v as never)
          }
        }
        let index = 0
        for (const op of event.changes.delta) {
          if (op.retain !== undefined) index += op.retain
          else if (op.delete !== undefined) t.delete(index, op.delete)
          else if (Array.isArray(op.insert)) {
            const ys = (op.insert as unknown[]).filter((n): n is Y.XmlElement | Y.XmlText =>
              n instanceof Y.XmlElement || n instanceof Y.XmlText)
            const created = t.insert(index, ys.map(yToInit))
            created.forEach((node, i) => this.bindDeep(ys[i], node))
            index += created.length
          }
        }
      }
    }, this.tag)
  }

  /** Ecrit tout le Y.Doc dans l'arbre, sous 'doc' (et relie tout). */
  private writeWholeDoc(): void {
    this.toTree.clear()
    this.toY.clear()
    const init: TreeElementInit = fragmentToInit(this.fragment)
    const created = this.tree.root.set(DOC_KEY, init)
    if (typeof created === 'object' && created !== null && created.kind === 'element') {
      this.bindDeep(this.fragment, created)
    }
  }
}
