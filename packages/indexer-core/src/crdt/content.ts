// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Contenu indexable d'un document, lu dans son Y.Doc, selon son type.
// Tout devient du Markdown, lu ensuite par la meme extraction que les notes
// (comme l'export Markdown de plugin-page, fait « pour l'indexation ») :
//
//  - .md, .outline : le texte partage 'codemirror' (frontmatter pour .md) ;
//  - .page : l'arbre partage (racine 'tree', cle 'doc' : un element 'doc'
//    a la forme de y-prosemirror), rendu en Markdown : titres, paragraphes,
//    listes, code, [[sous-pages]], [liens](...) ;
//  - .excalidraw : les textes visibles (cles 'el:<id>', JSON d'element ;
//    'z:<id>', rang d'affichage) ;
//  - .mindmap : les sujets des noeuds (cles 'node:<id>' : parent, order,
//    topic), en liste imbriquee, puis les libelles des fleches et resumes ;
//  - autres : rien (null).
//
// Les dispositions lues sont celles des plugins (plugin-page TreeMirror,
// plugin-excalidraw binding, plugin-mindmap model) ; les tests ecrivent les
// documents avec le code de ces plugins.
import * as Y from 'yjs'
import { extOf } from '../paths'
import type { NoteInput } from '../extract/note'
import { withDoc } from './yjs'
import type { YjsUpdate } from './yjs'

export const TEXT_NAME = 'codemirror'
export const TREE_ROOT = 'tree'
export const PAGE_KEY = 'doc'

export interface DocContent {
  /** Markdown a indexer. */
  content: string
  /** Vrai si le contenu peut commencer par un frontmatter (proprietes). */
  frontmatter: boolean
}

// ── Pages ────────────────────────────────────────────────────────────────

type YNode = Y.XmlElement | Y.XmlText

function childrenOf(el: Y.XmlElement): YNode[] {
  return el.toArray().filter((c): c is YNode => c instanceof Y.XmlElement || c instanceof Y.XmlText)
}

function inlineText(text: Y.XmlText): string {
  let out = ''
  for (const op of text.toDelta() as { insert?: unknown; attributes?: Record<string, unknown> }[]) {
    if (typeof op.insert !== 'string') continue
    let s = op.insert
    const attrs = op.attributes ?? {}
    if (attrs['code'] && !s.includes('`')) s = '`' + s + '`'
    const link = attrs['link'] as { href?: unknown } | undefined
    if (link && typeof link.href === 'string' && link.href) s = `[${s}](${link.href})`
    out += s
  }
  return out
}

function inlineOf(el: Y.XmlElement): string {
  let out = ''
  for (const c of childrenOf(el)) {
    if (c instanceof Y.XmlText) out += inlineText(c)
    else if (c.nodeName === 'hardBreak') out += '\n'
    else out += inlineOf(c)
  }
  return out
}

function indent(text: string, first: string, rest: string): string {
  return text.split('\n').map((line, i) => (i === 0 ? first : rest) + line).join('\n')
}

function pageBlock(node: YNode): string {
  if (node instanceof Y.XmlText) return inlineText(node)
  const attr = (k: string) => node.getAttribute(k) as unknown
  switch (node.nodeName) {
    case 'paragraph': return inlineOf(node)
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(attr('level') ?? 1) || 1))
      return '#'.repeat(level) + ' ' + inlineOf(node).replace(/\n/g, ' ')
    }
    case 'codeBlock': return '```\n' + inlineOf(node).replace(/^```/gm, '') + '\n```'
    case 'horizontalRule': return ''
    case 'pageLink': {
      const target = attr('target')
      return typeof target === 'string' && target ? `[[${target}]]` : ''
    }
    case 'blockquote':
      return childrenOf(node).map(pageBlock).filter(Boolean).map(b => indent(b, '> ', '> ')).join('\n')
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return childrenOf(node).map(item => {
        const body = item instanceof Y.XmlText ? inlineText(item) : childrenOf(item).map(pageBlock).filter(Boolean).join('\n')
        return indent(body, '- ', '  ')
      }).join('\n')
    default:
      return childrenOf(node).map(pageBlock).filter(Boolean).join('\n\n')
  }
}

/** Markdown d'une page, depuis l'arbre partage de son document. */
export function pageMarkdown(doc: Y.Doc): string {
  const page = doc.getMap<unknown>(TREE_ROOT).get(PAGE_KEY)
  if (!(page instanceof Y.XmlElement)) return ''
  return childrenOf(page).map(pageBlock).filter(b => b.trim()).join('\n\n')
}

// ── Excalidraw ───────────────────────────────────────────────────────────

/** Textes visibles d'un dessin, dans l'ordre d'affichage. */
export function excalidrawMarkdown(doc: Y.Doc): string {
  const root = doc.getMap<unknown>(TREE_ROOT)
  const texts: { id: string; z: number; text: string }[] = []
  root.forEach((v, key) => {
    if (!key.startsWith('el:') || typeof v !== 'string') return
    let el: { id?: unknown; type?: unknown; text?: unknown; originalText?: unknown; isDeleted?: unknown }
    try { el = JSON.parse(v) } catch { return }
    if (!el || el.isDeleted === true || el.type !== 'text') return
    const text = typeof el.originalText === 'string' ? el.originalText : typeof el.text === 'string' ? el.text : ''
    if (!text.trim()) return
    const id = key.slice(3)
    const z = root.get('z:' + id)
    texts.push({ id, z: typeof z === 'number' ? z : Number.POSITIVE_INFINITY, text: text.trim() })
  })
  texts.sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return texts.map(t => t.text).join('\n\n')
}

// ── Carte mentale ────────────────────────────────────────────────────────

interface MindNode { id: string; parent: string | null; order: string; topic: string }

function labelOf(json: unknown): string {
  if (typeof json !== 'string') return ''
  try {
    const v = JSON.parse(json) as { label?: unknown }
    return typeof v?.label === 'string' ? v.label.trim() : ''
  } catch { return '' }
}

/** Sujets d'une carte mentale, en liste imbriquee, puis fleches et resumes. */
export function mindmapMarkdown(doc: Y.Doc): string {
  const root = doc.getMap<unknown>(TREE_ROOT)
  const nodes = new Map<string, MindNode>()
  const labels: string[] = []
  root.forEach((v, key) => {
    if (key.startsWith('node:') && v instanceof Y.Map) {
      const parent = v.get('parent')
      const order = v.get('order')
      const topic = v.get('topic')
      nodes.set(key.slice(5), {
        id: key.slice(5),
        parent: typeof parent === 'string' ? parent : null,
        order: typeof order === 'string' ? order : '',
        topic: topic instanceof Y.Text ? topic.toString() : typeof topic === 'string' ? topic : '',
      })
    } else if (key.startsWith('arrow:') || key.startsWith('summary:')) {
      const label = labelOf(v)
      if (label) labels.push(label)
    }
  })
  // Un noeud sans parent connu est une racine ; ordre : cle d'ordre, puis id.
  const kids = new Map<string | null, MindNode[]>()
  for (const n of nodes.values()) {
    const p = n.parent !== null && n.parent !== n.id && nodes.has(n.parent) ? n.parent : null
    const list = kids.get(p)
    if (list) list.push(n)
    else kids.set(p, [n])
  }
  const cmp = (a: MindNode, b: MindNode) =>
    a.order !== b.order ? (a.order < b.order ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  for (const list of kids.values()) list.sort(cmp)

  const lines: string[] = []
  const seen = new Set<string>()
  const walk = (n: MindNode, depth: number) => {
    if (seen.has(n.id)) return
    seen.add(n.id)
    const topic = n.topic.replace(/\s+/g, ' ').trim()
    if (topic) lines.push('  '.repeat(depth) + '- ' + topic)
    for (const c of kids.get(n.id) ?? []) walk(c, depth + 1)
  }
  for (const r of kids.get(null) ?? []) walk(r, 0)
  // Noeuds pris dans un cycle (fusion concurrente) : a la suite, par id.
  for (const n of [...nodes.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) walk(n, 0)
  labels.sort()
  return [...lines, ...(labels.length ? ['', ...labels] : [])].join('\n')
}

// ── Par type ─────────────────────────────────────────────────────────────

/** Contenu indexable d'un document, selon l'extension de son chemin. null : type non indexe. */
export function readDocContent(path: string, doc: Y.Doc): DocContent | null {
  switch (extOf(path)) {
    case 'md': return { content: doc.getText(TEXT_NAME).toString(), frontmatter: true }
    case 'outline': return { content: doc.getText(TEXT_NAME).toString(), frontmatter: false }
    case 'page': return { content: pageMarkdown(doc), frontmatter: false }
    case 'excalidraw': return { content: excalidrawMarkdown(doc), frontmatter: false }
    case 'mindmap': return { content: mindmapMarkdown(doc), frontmatter: false }
    default: return null
  }
}

/** La note a indexer depuis le journal Yjs d'un document ; null si son type n'est pas indexe. */
export function noteInputFromUpdates(id: string, path: string, updates: readonly YjsUpdate[]): NoteInput | null {
  return withDoc(updates, doc => {
    const c = readDocContent(path, doc)
    return c ? { id, path, content: c.content, frontmatter: c.frontmatter } : null
  })
}
