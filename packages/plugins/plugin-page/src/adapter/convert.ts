// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Conversions entre les trois formes d'une page :
//   - le JSON ProseMirror (fichier en mode local, export Markdown) ;
//   - le Y.Doc PRIVE du plugin (XmlFragment, lie a Tiptap par y-prosemirror) ;
//   - les descriptions de l'arbre partage (TreeElementInit...).
//
// La forme est la meme partout, celle de y-prosemirror : un noeud est un
// element (nom + attributs + enfants) ; les textes qui se suivent forment un
// seul texte riche, dont les marques sont des attributs de format.
// Convention de l'arbre : une marque sans attribut vaut `true` ; dans le
// Y.Doc, y-prosemirror l'ecrit `{}`. Les attributs null d'une marque (valeur
// par defaut) ne vont pas dans l'arbre : `{ color: null }` y vaut `true`.
import * as Y from 'yjs'
import type {
  JsonValue, RichTextDelta, TextAttributes, TreeElementChildInit, TreeElementInit,
} from '@savoire/plugin-api'

/** Nom du fragment du Y.Doc prive qui porte la page. */
export const PAGE_FRAGMENT = 'page'

/** Noeud ProseMirror en JSON (forme de node.toJSON()). */
export interface PmJson {
  type: string
  attrs?: Record<string, unknown>
  content?: PmJson[]
  marks?: { type: string; attrs?: Record<string, unknown> }[]
  text?: string
}

// ── Attributs de format ──────────────────────────────────────────────────

function isEmptyObject(v: unknown): boolean {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0
}

/**
 * Valeur d'une marque dans l'arbre : ses attributs sans les null (valeurs
 * par defaut, que y-prosemirror et toJSON() ecrivent quand meme), ou `true`
 * s'il n'en reste aucun. Un surlignage sans couleur vaut donc `true`, un
 * surlignage rouge `{ color: 'red' }`.
 */
function markValue(attrs: unknown): JsonValue {
  if (typeof attrs !== 'object' || attrs === null || Array.isArray(attrs)) return true
  const out: Record<string, JsonValue> = {}
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) out[k] = v as JsonValue
  return Object.keys(out).length ? out : true
}

/** Attributs de format Y.Doc -> arbre. null (retrait) reste null. */
export function formatToTree(attrs: Record<string, unknown> | undefined): TextAttributes | undefined {
  if (!attrs) return undefined
  const out: TextAttributes = {}
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) continue
    out[k] = v === null ? null : markValue(v)
  }
  return Object.keys(out).length ? out : undefined
}

/** Attributs de format arbre -> Y.Doc. null (retrait) reste null. */
export function formatToY(attrs: TextAttributes | undefined): Record<string, unknown> | undefined {
  if (!attrs) return undefined
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(attrs)) out[k] = v === true ? {} : v
  return out
}

/** Delta Yjs (texte riche) -> delta de l'arbre. */
export function yDeltaToTree(delta: readonly Record<string, unknown>[]): RichTextDelta {
  const out: RichTextDelta = []
  for (const op of delta) {
    const attributes = formatToTree(op.attributes as Record<string, unknown> | undefined)
    if (typeof op.insert === 'string') out.push(attributes ? { insert: op.insert, attributes } : { insert: op.insert })
    else if (typeof op.retain === 'number') out.push(attributes ? { retain: op.retain, attributes } : { retain: op.retain })
    else if (typeof op.delete === 'number') out.push({ delete: op.delete })
    // Les objets inseres (embeds) ne sont pas utilises par y-prosemirror.
  }
  return out
}

/** Delta de l'arbre -> delta Yjs. */
export function treeDeltaToY(delta: RichTextDelta): Record<string, unknown>[] {
  return delta.map(op => {
    if ('insert' in op) return op.attributes ? { insert: op.insert, attributes: formatToY(op.attributes) } : { insert: op.insert }
    if ('retain' in op) return op.attributes ? { retain: op.retain, attributes: formatToY(op.attributes) } : { retain: op.retain }
    return { delete: op.delete }
  })
}

// ── Y.Doc -> descriptions ────────────────────────────────────────────────

function elementAttributes(el: Y.XmlElement): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {}
  for (const [k, v] of Object.entries(el.getAttributes())) {
    if (v !== undefined) out[k] = v as JsonValue
  }
  return out
}

/** Description d'un noeud du Y.Doc, sous-arbre compris. */
export function yToInit(node: Y.XmlElement | Y.XmlText): TreeElementChildInit {
  if (node instanceof Y.XmlText) {
    return { kind: 'text', delta: yDeltaToTree(node.toDelta() as Record<string, unknown>[]) }
  }
  const attributes = elementAttributes(node)
  return {
    kind: 'element',
    name: node.nodeName,
    ...(Object.keys(attributes).length ? { attributes } : {}),
    children: yChildren(node).map(yToInit),
  }
}

/** Enfants elements/textes d'un element ou du fragment. */
export function yChildren(parent: Y.XmlElement | Y.XmlFragment): (Y.XmlElement | Y.XmlText)[] {
  return parent.toArray().filter((c): c is Y.XmlElement | Y.XmlText =>
    c instanceof Y.XmlElement || c instanceof Y.XmlText)
}

// ── JSON ProseMirror <-> descriptions ────────────────────────────────────

function marksToAttributes(marks: PmJson['marks']): TextAttributes | undefined {
  if (!marks?.length) return undefined
  const out: TextAttributes = {}
  for (const m of marks) out[m.type] = markValue(m.attrs)
  return out
}

function cleanAttrs(attrs: Record<string, unknown> | undefined): Record<string, JsonValue> | undefined {
  if (!attrs) return undefined
  const out: Record<string, JsonValue> = {}
  // y-prosemirror n'ecrit pas les attributs null : meme regle ici.
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) out[k] = v as JsonValue
  return Object.keys(out).length ? out : undefined
}

/** Enfants d'un noeud JSON : les textes consecutifs forment un seul texte riche. */
function pmChildrenToInit(content: PmJson[] | undefined): TreeElementChildInit[] {
  const out: TreeElementChildInit[] = []
  let run: RichTextDelta | null = null
  for (const child of content ?? []) {
    if (child.type === 'text') {
      if (!child.text) continue
      run ??= []
      const attributes = marksToAttributes(child.marks)
      run.push(attributes ? { insert: child.text, attributes } : { insert: child.text })
      continue
    }
    if (run) { out.push({ kind: 'text', delta: run }); run = null }
    out.push(pmToInit(child))
  }
  if (run) out.push({ kind: 'text', delta: run })
  return out
}

/** Noeud JSON ProseMirror -> description d'element. */
export function pmToInit(node: PmJson): TreeElementInit {
  const attributes = cleanAttrs(node.attrs)
  return {
    kind: 'element',
    name: node.type,
    ...(attributes ? { attributes } : {}),
    children: pmChildrenToInit(node.content),
  }
}

/** Description -> JSON ProseMirror. */
export function initToPm(init: TreeElementInit): PmJson {
  const content: PmJson[] = []
  for (const child of init.children ?? []) {
    if (child.kind === 'element') { content.push(initToPm(child)); continue }
    for (const op of child.delta ?? []) {
      if (!('insert' in op) || !op.insert) continue
      const marks = Object.entries(op.attributes ?? {})
        .filter(([, v]) => v !== null && v !== false)
        .map(([type, v]) => (v === true || isEmptyObject(v)) ? { type } : { type, attrs: v as Record<string, unknown> })
      content.push(marks.length ? { type: 'text', text: op.insert, marks } : { type: 'text', text: op.insert })
    }
  }
  const out: PmJson = { type: init.name }
  if (init.attributes && Object.keys(init.attributes).length) out.attrs = { ...init.attributes }
  if (content.length) out.content = content
  return out
}

// ── Descriptions -> Y.Doc ────────────────────────────────────────────────

/**
 * Cree dans le Y.Doc les enfants decrits, a la position donnee. Les noeuds
 * sont d'abord inseres vides, puis remplis : c'est l'ordre le plus sur avec
 * Yjs. A appeler dans une transaction du Y.Doc. `onCreated` voit chaque
 * paire (description, noeud cree), pour la liaison avec l'arbre.
 */
export function insertInitsIntoY(
  parent: Y.XmlElement | Y.XmlFragment,
  index: number,
  inits: readonly TreeElementChildInit[],
  onCreated?: (init: TreeElementChildInit, node: Y.XmlElement | Y.XmlText, path: number[]) => void,
  path: number[] = [],
): (Y.XmlElement | Y.XmlText)[] {
  const created = inits.map(init => init.kind === 'element' ? new Y.XmlElement(init.name) : new Y.XmlText())
  if (created.length) parent.insert(index, created)
  inits.forEach((init, i) => {
    const node = created[i]
    if (init.kind === 'element' && node instanceof Y.XmlElement) {
      for (const [k, v] of Object.entries(init.attributes ?? {})) {
        if (v !== null) node.setAttribute(k, v as never)
      }
      insertInitsIntoY(node, 0, init.children ?? [], onCreated, [...path, i])
    } else if (init.kind === 'text' && node instanceof Y.XmlText && init.delta?.length) {
      node.applyDelta(treeDeltaToY(init.delta))
    }
    onCreated?.(init, node, [...path, i])
  })
  return created
}

/** Remplace tout le contenu du fragment par la description d'un 'doc'. */
export function replaceFragment(fragment: Y.XmlFragment, doc: TreeElementInit): void {
  if (fragment.length) fragment.delete(0, fragment.length)
  insertInitsIntoY(fragment, 0, doc.children ?? [])
}

/** Le fragment entier, en description d'element 'doc'. */
export function fragmentToInit(fragment: Y.XmlFragment): TreeElementInit {
  return { kind: 'element', name: 'doc', children: yChildren(fragment).map(yToInit) }
}

/** Le fragment entier, en JSON ProseMirror. */
export function fragmentToPm(fragment: Y.XmlFragment): PmJson {
  return initToPm(fragmentToInit(fragment))
}

/** Un Y.Doc prive de page, et son fragment. */
export function createPageDoc(): { doc: Y.Doc; fragment: Y.XmlFragment } {
  const doc = new Y.Doc()
  return { doc, fragment: doc.getXmlFragment(PAGE_FRAGMENT) }
}
