// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Coller intelligemment :
// - une adresse collee sur un texte selectionne en fait un lien [texte](adresse) ;
// - un texte copie d'une page web, d'un traitement de texte ou d'une note
//   rendue garde sa mise en forme (gras, listes, liens, tableaux...) ;
// - Ctrl+Maj+V colle le texte brut, sans rien convertir.
// Les images collees restent l'affaire d'ImageInsert.

import { EditorSelection, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

const URL_RE = /^(https?:\/\/|mailto:)[^\s<>"]+$/i

/** Balises qui portent une mise en forme : sans elles, le texte brut suffit (code copie d'un editeur...). */
const MEANINGFUL = 'b, strong, i, em, s, del, strike, a[href], h1, h2, h3, h4, h5, h6, ul, ol, table, blockquote, pre, code, img, hr, mark, span[style*="font-weight"], span[style*="italic"]'

// ── HTML -> Markdown ────────────────────────────────────────────────────────

const BLOCKS = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'NAV', 'FIGURE', 'FIGCAPTION', 'ADDRESS', 'DL', 'DT', 'DD'])

interface Ctx { pre: boolean; listDepth: number }

function styleOf(el: Element): CSSStyleDeclaration | null {
  return (el as HTMLElement).style ?? null
}

function isBold(el: Element): boolean {
  if (el.tagName === 'B') {
    // Google Docs entoure tout d'un <b style="font-weight:normal">.
    const w = styleOf(el)?.fontWeight
    return !(w === 'normal' || w === '400')
  }
  if (el.tagName === 'STRONG') return true
  const w = styleOf(el)?.fontWeight
  return !!w && (w === 'bold' || Number(w) >= 600)
}

function isItalic(el: Element): boolean {
  return el.tagName === 'I' || el.tagName === 'EM' || styleOf(el)?.fontStyle === 'italic'
}

function isStrike(el: Element): boolean {
  return ['S', 'DEL', 'STRIKE'].includes(el.tagName) || /line-through/.test(styleOf(el)?.textDecoration ?? '')
}

/** Entoure `text` de `mark` sans prendre ses blancs de bord (« **mot** » et pas « ** mot** »). */
function wrap(text: string, mark: string): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!
  return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : text
}

function inline(node: Node, ctx: Ctx): string {
  let out = ''
  for (const child of Array.from(node.childNodes)) out += inlineNode(child, ctx)
  return out
}

function inlineNode(node: Node, ctx: Ctx): string {
  if (node.nodeType === Node.TEXT_NODE) {
    const t = node.textContent ?? ''
    return ctx.pre ? t : t.replace(/[\s\u00a0]+/g, ' ')
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return ''
  const el = node as Element
  const tag = el.tagName
  if (tag === 'BR') return '\n'
  if (tag === 'IMG') {
    const src = el.getAttribute('src') ?? ''
    // Une image du web seulement (pas data: ni un fichier local de Word).
    return /^https?:\/\//i.test(src) ? `![${el.getAttribute('alt') ?? ''}](${src})` : ''
  }
  if (tag === 'CODE' && !ctx.pre) {
    const t = el.textContent ?? ''
    return t.includes('`') ? `\`\` ${t} \`\`` : `\`${t}\``
  }
  if (tag === 'INPUT' && (el as HTMLInputElement).type === 'checkbox') return (el as HTMLInputElement).checked ? '[x] ' : '[ ] '
  if (['SCRIPT', 'STYLE', 'META', 'LINK', 'TITLE', 'BUTTON'].includes(tag)) return ''
  let text = BLOCKS.has(tag) || /^H[1-6]$/.test(tag) || tag === 'LI' || tag === 'UL' || tag === 'OL' || tag === 'TABLE' || tag === 'BLOCKQUOTE' || tag === 'PRE' || tag === 'HR'
    ? blocks(el, ctx)
    : inline(el, ctx)
  if (tag === 'A') {
    const href = el.getAttribute('href') ?? ''
    if (href && !href.startsWith('#') && !href.startsWith('javascript:') && text.trim()) text = `[${text.trim()}](${href})`
    return text
  }
  if (tag === 'MARK') text = wrap(text, '==')
  if (isStrike(el)) text = wrap(text, '~~')
  if (isItalic(el)) text = wrap(text, '*')
  if (isBold(el)) text = wrap(text, '**')
  return text
}

/** Le Markdown des enfants d'un element, blocs separes par une ligne vide. */
function blocks(node: Node, ctx: Ctx): string {
  const parts: string[] = []
  let line = ''
  const flush = () => {
    const t = line.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    if (t) parts.push(t)
    line = ''
  }
  for (const child of Array.from(node.childNodes)) {
    const md = blockNode(child, ctx)
    if (md === null) { line += inlineNode(child, ctx); continue }
    flush()
    if (md.trim()) parts.push(md)
  }
  flush()
  return parts.join('\n\n')
}

/** Le Markdown d'un bloc, ou null si c'est du texte en ligne. */
function blockNode(node: Node, ctx: Ctx): string | null {
  if (node.nodeType !== Node.ELEMENT_NODE) return null
  const el = node as Element
  const tag = el.tagName
  const h = /^H([1-6])$/.exec(tag)
  if (h) return `${'#'.repeat(Number(h[1]))} ${inline(el, ctx).replace(/\s+/g, ' ').trim()}`
  if (tag === 'HR') return '---'
  if (tag === 'PRE') {
    const code = el.textContent ?? ''
    const lang = /language-(\w+)/.exec(el.querySelector('code')?.className ?? el.className)?.[1] ?? ''
    return '```' + lang + '\n' + code.replace(/\n$/, '') + '\n```'
  }
  if (tag === 'BLOCKQUOTE') return blocks(el, ctx).split('\n').map(l => (l ? `> ${l}` : '>')).join('\n')
  if (tag === 'UL' || tag === 'OL') return list(el, ctx)
  if (tag === 'TABLE') return table(el, ctx)
  if (BLOCKS.has(tag) || tag === 'LI') return blocks(el, ctx)
  return null
}

function list(el: Element, ctx: Ctx): string {
  const ordered = el.tagName === 'OL'
  let n = Number(el.getAttribute('start') ?? '1') || 1
  const items: string[] = []
  for (const li of Array.from(el.children)) {
    if (li.tagName !== 'LI') continue
    const body = blocks(li, { ...ctx, listDepth: ctx.listDepth + 1 })
    const marker = ordered ? `${n++}.` : '-'
    const pad = ' '.repeat(marker.length + 1)
    // Les lignes suivantes (sous-liste, suite) s'alignent sous le texte.
    const lines = body.replace(/\n\n+/g, '\n').split('\n')
    items.push(`${marker} ${lines[0] ?? ''}` + lines.slice(1).map(l => `\n${l ? pad + l : ''}`).join(''))
  }
  return items.join('\n')
}

function table(el: Element, ctx: Ctx): string {
  const rows = Array.from(el.querySelectorAll('tr')).filter(r => r.closest('table') === el)
  if (rows.length === 0) return ''
  const cells = rows.map(r => Array.from(r.children).filter(c => c.tagName === 'TD' || c.tagName === 'TH')
    .map(c => inline(c, ctx).replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim()))
  const width = Math.max(...cells.map(r => r.length))
  const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`
  return [line(cells[0]), `|${' --- |'.repeat(width)}`, ...cells.slice(1).map(line)].join('\n')
}

/** Le Markdown d'un fragment HTML colle. */
export function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return blocks(doc.body, { pre: false, listDepth: 0 }).replace(/\u00a0/g, ' ').trim()
}

/** Vrai si le HTML porte une mise en forme qui merite d'etre gardee. */
export function htmlHasFormatting(html: string): boolean {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return !!doc.body.querySelector(MEANINGFUL)
}

// ── Le collage ──────────────────────────────────────────────────────────────

/** Ctrl+Maj+V juste avant : coller le texte brut. */
let plainUntil = 0

export const smartPaste: Extension = EditorView.domEventHandlers({
  keydown(e) {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'v' || e.key === 'V')) plainUntil = Date.now() + 1000
    return false
  },
  paste(event, view) {
    const data = event.clipboardData
    if (!data || view.state.readOnly) return false
    const plain = Date.now() < plainUntil
    plainUntil = 0
    if (plain) return false
    // Des images seules : ImageInsert s'en charge.
    if (data.files.length > 0 && !data.getData('text/plain')) return false
    const text = data.getData('text/plain')
    const main = view.state.selection.main
    // Une adresse sur un texte selectionne : un lien.
    if (URL_RE.test(text.trim()) && !main.empty && view.state.selection.ranges.length === 1) {
      const label = view.state.sliceDoc(main.from, main.to)
      if (!label.includes('\n') && !URL_RE.test(label.trim())) {
        event.preventDefault()
        const insert = `[${label}](${text.trim()})`
        view.dispatch({ changes: { from: main.from, to: main.to, insert }, selection: EditorSelection.cursor(main.from + insert.length), userEvent: 'input.paste', scrollIntoView: true })
        return true
      }
    }
    const html = data.getData('text/html')
    if (!html || !htmlHasFormatting(html)) return false
    const md = htmlToMarkdown(html)
    if (!md) return false
    event.preventDefault()
    view.dispatch(view.state.replaceSelection(md), { userEvent: 'input.paste', scrollIntoView: true })
    return true
  },
})
