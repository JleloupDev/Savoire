// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Apercus en lecture seule des plugins de documents (Word, PDF, images...).
// Generique : le contenu extrait (titre, proprietes, sections, tableaux).
// Particuliers : HTML (cadre sans script), PDF et images (le navigateur).
import type { ExtractedContent, ExtractorSpec } from './extractors'
import type { PropertyValue } from './properties'
import type { FileContext, FileView } from './files'

const STYLE = `
.doc-preview { max-width: 860px; margin: 0 auto; padding: 24px 32px 48px; font: 15px/1.6 var(--font-editor, Georgia, serif); color: var(--text, #1e293b); }
.doc-preview h1 { font-size: 1.6em; margin: 0 0 .6em; }
.doc-preview h2 { font-size: 1.15em; margin: 1.4em 0 .4em; }
.doc-preview p { margin: 0 0 .6em; white-space: pre-wrap; }
.doc-preview .doc-props { font: 12px var(--font-ui, sans-serif); color: var(--text-muted, #64748b); display: flex; flex-wrap: wrap; gap: 4px 14px; margin-bottom: 18px; }
.doc-preview table { border-collapse: collapse; font: 12.5px var(--font-ui, sans-serif); margin: 6px 0 18px; }
.doc-preview td { border: 1px solid var(--border, #e2e8f0); padding: 3px 8px; vertical-align: top; }
.doc-preview tr:first-child td { background: var(--bg-elevated, #f8fafc); font-weight: 600; }
.doc-preview .doc-more { font: 12px var(--font-ui, sans-serif); color: var(--text-faint, #94a3b8); }
.doc-banner { padding: 6px 14px; font: 12px var(--font-ui, sans-serif); color: var(--text-muted, #64748b); background: var(--bg-elevated, #f8fafc); border-bottom: 1px solid var(--border, #e2e8f0); }
`
let injected = false
export function ensureDocumentPreviewStyle(): void {
  if (injected || typeof document === 'undefined') return
  injected = true
  const s = document.createElement('style')
  s.dataset.savoire = 'plugin-documents'
  s.textContent = STYLE
  document.head.appendChild(s)
}

/** Lignes affichees au plus par tableau (l'index en garde plus). */
const MAX_SHOWN_ROWS = 300

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag)
  if (text !== undefined) e.textContent = text
  if (cls) e.className = cls
  return e
}

const show = (v: PropertyValue) => (Array.isArray(v) ? v.join(', ') : String(v))

export function genericPreview(content: ExtractedContent): HTMLElement {
  ensureDocumentPreviewStyle()
  const root = el('div', undefined, 'doc-preview')
  if (content.title) root.appendChild(el('h1', content.title))
  const props = Object.entries(content.props ?? {})
  if (props.length) {
    const box = el('div', undefined, 'doc-props')
    for (const [k, v] of props) box.appendChild(el('span', `${k.replace(/_/g, ' ')} : ${show(v)}`))
    root.appendChild(box)
  }
  for (const s of content.sections) {
    if (s.heading) root.appendChild(el('h2', s.heading))
    if (s.rows?.length) {
      const table = el('table')
      for (const r of s.rows.slice(0, MAX_SHOWN_ROWS)) {
        const tr = el('tr')
        for (const c of r) tr.appendChild(el('td', c))
        table.appendChild(tr)
      }
      root.appendChild(table)
      if (s.rows.length > MAX_SHOWN_ROWS) root.appendChild(el('div', `… ${s.rows.length - MAX_SHOWN_ROWS} lignes de plus`, 'doc-more'))
      continue
    }
    for (const para of s.text.split('\n')) if (para.trim()) root.appendChild(el('p', para))
  }
  if (!root.childElementCount) root.appendChild(el('p', '(Document vide)'))
  return root
}

/** HTML dans un cadre isole : sans script, sans acces a Savoire. */
export function htmlPreview(bytes: Uint8Array): HTMLElement {
  const frame = document.createElement('iframe')
  frame.setAttribute('sandbox', '')
  frame.setAttribute('referrerpolicy', 'no-referrer')
  frame.style.cssText = 'width:100%;height:100%;border:0;background:#fff'
  frame.srcdoc = new TextDecoder().decode(bytes)
  return frame
}

const MIME: Record<string, string> = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' }

/** Un fichier montre par le navigateur lui-meme (PDF, image), depuis ses octets. */
export function nativePreview(bytes: Uint8Array, ext: string): HTMLElement {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: MIME[ext] ?? 'application/octet-stream' }))
  if (ext === 'pdf') {
    const frame = document.createElement('iframe')
    frame.style.cssText = 'width:100%;height:100%;border:0'
    frame.src = url
    return frame
  }
  const img = document.createElement('img')
  img.src = url
  img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;display:block;margin:auto'
  return img
}

/**
 * Vue en lecture seule d'un document : un bandeau, puis l'apercu de son
 * extracteur (ou l'apercu generique du contenu extrait).
 */
export function createDocumentPreviewView(path: string, ctx: FileContext, spec: ExtractorSpec): FileView {
  let dead = false
  return {
    mount(container: HTMLElement) {
      ensureDocumentPreviewStyle()
      container.replaceChildren()
      container.style.cssText = 'height:100%;display:flex;flex-direction:column;overflow:hidden'
      const banner = el('div', 'Aperçu en lecture seule : ce document se modifie dans son logiciel.', 'doc-banner')
      banner.dataset.testid = 'document-banner'
      const body = el('div')
      body.dataset.testid = 'document-preview'
      body.style.cssText = 'flex:1;min-height:0;overflow:auto'
      container.append(banner, body)
      void (async () => {
        const bytes = await ctx.vault?.readBinary?.(path)
        if (dead) return
        if (!bytes) { body.textContent = 'Aperçu indisponible : les octets de ce fichier ne sont pas disponibles ici.'; return }
        const view = spec.preview ? await spec.preview(bytes, { path }) : genericPreview(await spec.extract(bytes, { path }))
        if (!dead) body.replaceChildren(view)
      })().catch(err => { if (!dead) body.textContent = `Aperçu impossible : ${err instanceof Error ? err.message : String(err)}` })
    },
    destroy() { dead = true },
  }
}
