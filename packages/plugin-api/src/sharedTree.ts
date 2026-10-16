// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// ─── Arbre partage d'un document ──────────────────────────────────────────
//
// Troisieme brique de l'API CRDT des plugins (apres ISharedMap et
// ISharedText) : un document JSON structure, edite par plusieurs membres en
// meme temps. C'est le contenu d'un document de type 'crdt' qui n'est pas du
// texte brut (une page facon Notion stockee en arbre ProseMirror...).
//
// Quatre sortes de noeuds, portables vers Yjs comme vers Automerge :
//   - carte   (ITreeMap)     : cle -> valeur ;
//   - liste   (ITreeList)    : valeurs ordonnees ;
//   - texte   (ITreeText)    : texte riche, attributs de format sur des plages ;
//   - element (ITreeElement) : nom + attributs + enfants ordonnes (elements ou
//     textes). C'est la forme d'un noeud ProseMirror : un paragraphe est un
//     element 'paragraph' dont les enfants sont des textes (avec leurs
//     marques en attributs de format) et des elements en ligne.
// Les feuilles sont des primitives (null, booleen, nombre, chaine). Un objet
// JSON se stocke en carte, ou en chaine si on veut le remplacer en bloc. Les
// attributs d'un element, eux, acceptent n'importe quelle valeur JSON (ils
// sont toujours remplaces en bloc).
//
// Rien ici n'expose de bibliotheque CRDT. Voir docs/Architecture/plugin-crdt-api.md.

import type { ChangeOrigin } from './sharedText'

// ── Valeurs ──────────────────────────────────────────────────────────────

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** Feuille d'une carte ou d'une liste. */
export type TreePrimitive = null | boolean | number | string

export type TreeNode = ITreeMap | ITreeList | ITreeText | ITreeElement

/** Enfant d'un element. */
export type TreeElementChild = ITreeElement | ITreeText

/**
 * Valeur lue dans une carte ou une liste : une primitive, ou un noeud.
 * Distinguer : `typeof v === 'object' && v !== null` => noeud (voir `kind`).
 */
export type TreeValue = TreePrimitive | TreeNode

// ── Creation ─────────────────────────────────────────────────────────────
// Un noeud se cree en l'inserant, depuis une description. L'insertion rend
// le noeud cree (sa poignee), deja en place dans l'arbre.

export interface TreeMapInit {
  kind: 'map'
  entries?: Record<string, TreeValueInit>
}

export interface TreeListInit {
  kind: 'list'
  items?: TreeValueInit[]
}

export interface TreeTextInit {
  kind: 'text'
  /** Contenu initial : des insertions, avec leurs attributs de format. */
  delta?: RichTextDelta
}

export interface TreeElementInit {
  kind: 'element'
  name: string
  attributes?: Record<string, JsonValue>
  children?: TreeElementChildInit[]
}

export type TreeElementChildInit = TreeElementInit | TreeTextInit
export type TreeNodeInit = TreeMapInit | TreeListInit | TreeTextInit | TreeElementInit
export type TreeValueInit = TreePrimitive | TreeNodeInit

// ── Deltas ───────────────────────────────────────────────────────────────

/**
 * Attributs de format d'une plage de texte (les marques ProseMirror :
 * { bold: true }, { link: { href: '...' } }). Dans un retain, une valeur
 * null RETIRE l'attribut.
 */
export type TextAttributes = Record<string, JsonValue>

export type RichTextDeltaOp =
  | { retain: number; attributes?: TextAttributes }
  | { insert: string; attributes?: TextAttributes }
  | { delete: number }

/** Delta de texte riche. Positions en unites UTF-16, comme String.length. */
export type RichTextDelta = RichTextDeltaOp[]

/** Delta de liste : les valeurs inserees sont les noeuds deja en place. */
export type ListDeltaOp<T = TreeValue> =
  | { retain: number }
  | { insert: T[] }
  | { delete: number }

export type ListDelta<T = TreeValue> = ListDeltaOp<T>[]

// ── Changements ──────────────────────────────────────────────────────────

export interface TreeMapChange {
  kind: 'map'
  target: ITreeMap
  /** Cles ajoutees, modifiees ou supprimees. Lire les nouvelles valeurs dans target. */
  keys: string[]
}

export interface TreeListChange {
  kind: 'list'
  target: ITreeList
  delta: ListDelta
}

export interface TreeTextChange {
  kind: 'text'
  target: ITreeText
  delta: RichTextDelta
}

export interface TreeElementChange {
  kind: 'element'
  target: ITreeElement
  /** Attributs ajoutes, modifies ou retires. */
  attributes: string[]
  /** Changement des enfants (vide si seuls des attributs ont change). */
  children: ListDelta<TreeElementChild>
}

export type TreeChange = TreeMapChange | TreeListChange | TreeTextChange | TreeElementChange

export interface TreeChangeInfo {
  origin: ChangeOrigin
  /**
   * Etiquette passee a transact() par CE client. Absente pour un changement
   * distant, ou fait hors d'un transact etiquete. Sert a ignorer l'echo de
   * ses propres ecritures (voir ISharedTree.transact).
   */
  tag?: unknown
}

// Regles des changements, les memes pour tous les profils :
//  - Ils arrivent par lots, un lot par transaction, APRES la transaction.
//  - Dans un lot, appliquer les changements dans l'ordre. Le delta d'un
//    noeud s'exprime par rapport a son etat juste avant ce changement.
//  - Un noeud cree dans la transaction n'a pas de changement propre : il
//    apparait dans le delta de son parent, dans son etat de fin de lot.
//  - Un changement peut viser un noeud supprime dans le meme lot
//    (target.deleted) : l'ignorer.

// ── Noeuds ───────────────────────────────────────────────────────────────

interface ITreeNodeBase<C extends TreeChange> {
  /**
   * Identite du noeud : stable toute sa vie, la meme chez tous les membres.
   * La poignee aussi est stable : le meme noeud rend toujours le meme objet
   * (===), on peut s'en servir comme cle de Map.
   * Un noeud deplace (supprime puis reinsere) est un NOUVEAU noeud.
   */
  readonly id: string
  /** Parent du noeud ; null pour la racine. */
  readonly parent: TreeNode | null
  /** true une fois le noeud retire de l'arbre. Ses methodes n'ont plus d'effet. */
  readonly deleted: boolean
  /** Copie JSON du sous-arbre (un texte rend sa chaine, sans format). */
  toJSON(): JsonValue
  /** Changements de CE noeud seulement. Rend une fonction de desabonnement. */
  observe(cb: (change: C, info: TreeChangeInfo) => void): () => void
  /** Changements de ce noeud et de tout son sous-arbre, par lot. */
  observeDeep(cb: (changes: TreeChange[], info: TreeChangeInfo) => void): () => void
}

export interface ITreeMap extends ITreeNodeBase<TreeMapChange> {
  readonly kind: 'map'
  readonly size: number
  get(key: string): TreeValue | undefined
  has(key: string): boolean
  keys(): string[]
  /** Ecrit une valeur (remplace l'ancienne) et rend la valeur en place. */
  set(key: string, value: TreeValueInit): TreeValue
  delete(key: string): void
}

export interface ITreeList extends ITreeNodeBase<TreeListChange> {
  readonly kind: 'list'
  readonly length: number
  get(index: number): TreeValue | undefined
  toArray(): TreeValue[]
  /** Insere a la position donnee et rend les valeurs en place. */
  insert(index: number, values: TreeValueInit[]): TreeValue[]
  push(values: TreeValueInit[]): TreeValue[]
  delete(index: number, length?: number): void
}

export interface ITreeText extends ITreeNodeBase<TreeTextChange> {
  readonly kind: 'text'
  readonly length: number
  /** Texte brut. */
  toString(): string
  /** Contenu complet, en insertions avec leurs attributs de format. */
  toDelta(): RichTextDelta
  /** Sans attributs, le texte insere n'a aucun format (il n'herite pas de ses voisins). */
  insert(index: number, text: string, attributes?: TextAttributes): void
  delete(index: number, length: number): void
  /** Pose (ou retire, avec null) des attributs sur une plage. */
  format(index: number, length: number, attributes: TextAttributes): void
  /** Applique plusieurs operations en une seule modification. */
  applyDelta(delta: RichTextDelta): void
}

export interface ITreeElement extends ITreeNodeBase<TreeElementChange> {
  readonly kind: 'element'
  /** Nom de l'element ('paragraph', 'heading'...). Fixe a la creation. */
  readonly name: string
  getAttribute(name: string): JsonValue | undefined
  getAttributes(): Record<string, JsonValue>
  setAttribute(name: string, value: JsonValue): void
  removeAttribute(name: string): void
  /** Nombre d'enfants. */
  readonly length: number
  get(index: number): TreeElementChild | undefined
  toArray(): TreeElementChild[]
  insert(index: number, children: TreeElementChildInit[]): TreeElementChild[]
  push(children: TreeElementChildInit[]): TreeElementChild[]
  delete(index: number, length?: number): void
}

// ── Arbre ────────────────────────────────────────────────────────────────

export interface ISharedTree {
  /**
   * Racine : une carte. Un plugin y range son contenu sous une cle de son
   * choix (une page : root.set('doc', { kind: 'element', name: 'doc' })).
   */
  readonly root: ITreeMap
  /**
   * Groupe des ecritures : les membres et les abonnes les voient comme UNE
   * modification, en un seul lot. Un transact dans un transact rejoint le
   * premier. L'etiquette revient dans TreeChangeInfo.tag des changements
   * LOCAUX de ce lot : un plugin qui reflete un autre modele (un Y.Doc prive
   * d'editeur) ecrit sous son etiquette, et ignore les lots qui la portent.
   */
  transact(fn: () => void, tag?: unknown): void
  /** Tous les changements de l'arbre, par lot (= root.observeDeep). */
  onChange(cb: (changes: TreeChange[], info: TreeChangeInfo) => void): () => void
}
