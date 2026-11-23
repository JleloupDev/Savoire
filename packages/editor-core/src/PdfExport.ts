// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Export d'une note en PDF, comme dans Obsidian : la note entiere est rendue
// une fois, bloc par bloc (le meme decoupage que l'apercu en direct : les
// blocs des plugins avec leur rendu, le reste en Markdown), dans un cadre
// cache, puis imprimee. La boite d'impression du navigateur, ou de l'appli
// de bureau, propose « Enregistrer au format PDF ».
//
// Pas de bibliotheque PDF : le moteur d'impression du navigateur garde le
// texte selectionnable, les liens et les images nettes.
import type { BlockRegistry, HookRegistry } from '@savoire/plugin-api'
import { COLUMNS_CSS, renderFragmentInto } from './NoteFragment'

/** Blocs de plugins qu'on imprime en Markdown simple. */
const PRINT_AS_MARKDOWN = new Set(['code-block'])

export interface NoteRenderOptions {
  /** Titre en tete du document (nom de la note). Vide : pas de titre. */
  title?: string
  registry?: BlockRegistry | null
  hooks?: HookRegistry | null
  /** Plugins actifs dans cette note (null : tous). */
  activeIds?: Set<string> | null
}

/** Le frontmatter `---` en tete d'une note, ou null. */
function splitFrontmatter(text: string): { body: string } {
  const m = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  return { body: m ? text.slice(m[0].length) : text }
}

/**
 * La note rendue en entier, pour l'impression : chaque bloc de premier
 * niveau est rendu par le plugin qui le revendique, sinon en Markdown.
 */
export function renderNoteForPrint(text: string, opts: NoteRenderOptions = {}): HTMLElement {
  const root = document.createElement('article')
  root.className = 'savoire-print'
  if (opts.title) {
    const h = document.createElement('h1')
    h.className = 'savoire-print-title'
    h.textContent = opts.title
    root.appendChild(h)
  }
  const { body } = splitFrontmatter(text.replace(/\r\n?/g, '\n'))
  // Le code aussi en Markdown : sur papier, sans le fond sombre de l'editeur.
  renderFragmentInto(root, body, {
    registry: opts.registry,
    hooks: opts.hooks,
    activeIds: opts.activeIds,
    asMarkdown: PRINT_AS_MARKDOWN,
    pluginBoxClass: 'savoire-print-block',
  })
  return root
}

const PRINT_CSS = `
  @page { margin: 18mm 16mm; }
  :root {
    color-scheme: light;
    --text: #1f2328; --text-muted: #57606a; --text-faint: #8c959f;
    --bg: #ffffff; --bg-surface: #ffffff; --bg-elevated: #f6f8fa;
    --border: #d0d7de; --heading-color: #1f2328; --accent: #0969da;
  }
  html, body { background: #fff !important; color: var(--text); margin: 0; }
  body { font: 11pt/var(--plume-line-height, 1.6) Georgia, 'Times New Roman', serif; }
  /* Espace avant et apres les titres : celui du theme ou des preferences (Apparence > Texte). */
  .savoire-print h1 { margin: var(--plume-h1-before, 12pt) 0 var(--plume-h1-after, 4pt); }
  .savoire-print h2 { margin: var(--plume-h2-before, 10pt) 0 var(--plume-h2-after, 3pt); }
  .savoire-print h3 { margin: var(--plume-h3-before, 8pt) 0 var(--plume-h3-after, 2pt); }
  .savoire-print h4 { margin: var(--plume-h4-before, 6pt) 0 var(--plume-h4-after, 0pt); }
  .savoire-print h5 { margin: var(--plume-h5-before, 6pt) 0 var(--plume-h5-after, 0pt); }
  .savoire-print h6 { margin: var(--plume-h6-before, 6pt) 0 var(--plume-h6-after, 0pt); }
  .savoire-print > :first-child h1, .savoire-print > :first-child h2, .savoire-print > :first-child h3 { margin-top: 0; }
  .savoire-print { max-width: 100%; }
  .savoire-print-title { font-size: 22pt; margin: 0 0 14pt; font-weight: 700; }
  .savoire-print h1, .savoire-print h2, .savoire-print h3 { break-after: avoid; page-break-after: avoid; }
  .savoire-print .vault-rendered-block { padding: 0; margin: 0 0 8pt; }
  .savoire-print p { margin: 0 0 6pt; }
  .savoire-print pre, .savoire-print table, .savoire-print img, .savoire-print svg,
  .savoire-print .savoire-print-block { break-inside: avoid; page-break-inside: avoid; }
  .savoire-print .savoire-print-block { margin: 0 0 10pt; }
  .savoire-print img { max-width: 100%; height: auto; }
  .savoire-print .savoire-print-block svg { max-width: 100%; max-height: 90mm; }
  .savoire-print .savoire-print-block { text-align: center; }
  .savoire-print .savoire-print-block > * { text-align: left; }
  .savoire-print li:has(> input[type="checkbox"]) { list-style: none !important; }
  .savoire-print li:has(> input[type="checkbox"])::before, .savoire-print li:has(> input[type="checkbox"])::marker { content: none !important; display: none !important; }
  .savoire-print code { font-size: 9.5pt; }
  .savoire-print pre { white-space: pre-wrap; background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 4px; padding: 8pt; font-size: 9.5pt; }
  .savoire-print table { border-collapse: collapse; }
  .savoire-print th, .savoire-print td { border: 1px solid #d0d7de; padding: 3pt 6pt; }
  .savoire-print a { color: var(--accent); text-decoration: none; }
  .savoire-print button { display: none !important; }
  .savoire-print .plume-columns { break-inside: avoid; page-break-inside: avoid; }
${COLUMNS_CSS}`

/** Attend la fin des rendus asynchrones (images, diagrammes), sans depasser `maxMs`. */
async function settle(doc: Document, maxMs: number): Promise<void> {
  const end = Date.now() + maxMs
  const images = Array.from(doc.images).filter(i => !i.complete)
  await Promise.race([
    Promise.all(images.map(i => new Promise(r => { i.onload = i.onerror = r }))),
    new Promise(r => setTimeout(r, maxMs)),
  ])
  // Un diagramme se dessine apres coup : on attend que le contenu ne bouge plus.
  let last = -1
  while (Date.now() < end) {
    const size = doc.body.innerHTML.length
    if (size === last) break
    last = size
    await new Promise(r => setTimeout(r, 250))
  }
}

/**
 * Imprime la note : la boite d'impression s'ouvre, avec « Enregistrer au
 * format PDF ». Rend quand la boite est fermee (ou aussitot, selon le
 * navigateur).
 */
export async function printNote(text: string, opts: NoteRenderOptions = {}): Promise<void> {
  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden'
  document.body.appendChild(frame)
  try {
    const doc = frame.contentDocument!
    doc.open()
    doc.write('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>')
    doc.close()
    doc.title = opts.title || 'Note'
    // Les styles de l'appli (rendus des plugins), puis ceux de l'impression.
    for (const s of Array.from(document.querySelectorAll('style, link[rel="stylesheet"]'))) doc.head.appendChild(doc.importNode(s, true))
    const style = doc.createElement('style')
    // L'interligne et l'espace avant les titres choisis dans l'appli.
    const page = getComputedStyle(document.body)
    const typo = ['--plume-line-height', ...[1, 2, 3, 4, 5, 6].flatMap(n => [`--plume-h${n}-before`, `--plume-h${n}-after`])]
      .map(name => [name, page.getPropertyValue(name).trim()] as const)
      .filter(([, v]) => /^[\d.]+(pt|px|em)?$/.test(v))
      .map(([name, v]) => `${name}: ${v};`).join(' ')
    style.textContent = PRINT_CSS + (typo ? `\n:root { ${typo} }` : '')
    doc.head.appendChild(style)
    // Rendu dans cette page (memes modules, memes adresses blob: des images),
    // puis deplace dans le cadre.
    const content = renderNoteForPrint(text, opts)
    doc.body.appendChild(doc.adoptNode(content))
    await settle(doc, 4000)
    const previous = document.title
    // Le nom propose pour le fichier PDF vient du titre de la page.
    document.title = doc.title
    try {
      frame.contentWindow!.focus()
      frame.contentWindow!.print()
    } finally {
      document.title = previous
    }
  } finally {
    // Laisse le temps a la boite d'impression de lire le cadre.
    setTimeout(() => frame.remove(), 1000)
  }
}

// ── Publication sur le web ──────────────────────────────────────────────────

/** Taille maximale d'une image integree a une page publiee (octets). */
const MAX_PUBLISHED_IMAGE = 3 * 1024 * 1024

export interface PublishedHtml {
  html: string
  /** Premier paragraphe, pour les moteurs de recherche et les apercus de lien. */
  description: string
}

async function toDataUrl(src: string): Promise<string | null> {
  try {
    const res = await fetch(src)
    if (!res.ok) return null
    const blob = await res.blob()
    if (blob.size > MAX_PUBLISHED_IMAGE) return null
    return await new Promise(resolve => {
      const reader = new FileReader()
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}

/**
 * La note rendue pour une page publique : meme rendu que l'export PDF, puis
 * nettoyee pour etre servie a tous. Pas de script, pas de cadre, pas de
 * bouton ; les images deviennent des donnees integrees (elles ne dependent
 * plus de la session) ; un lien vers une autre note devient du texte (elle
 * n'est pas forcement publiee).
 */
export async function renderNoteForWeb(text: string, opts: NoteRenderOptions = {}): Promise<PublishedHtml> {
  const host = document.createElement('div')
  host.setAttribute('aria-hidden', 'true')
  host.style.cssText = 'position:fixed;left:-10000px;top:0;width:760px;visibility:hidden;pointer-events:none'
  document.body.appendChild(host)
  try {
    const content = renderNoteForPrint(text, opts)
    host.appendChild(content)
    await settle(document, 4000)
    for (const el of Array.from(content.querySelectorAll('script, iframe, object, embed, button, select, textarea, form, style, link, [contenteditable]'))) {
      if (el.matches('[contenteditable]') && !el.matches('script, iframe, object, embed, button, select, textarea, form, style, link')) el.removeAttribute('contenteditable')
      else el.remove()
    }
    for (const input of Array.from(content.querySelectorAll('input'))) {
      if (input.type === 'checkbox') input.setAttribute('disabled', '')
      else input.remove()
    }
    for (const a of Array.from(content.querySelectorAll('a'))) {
      const href = a.getAttribute('href') ?? ''
      if (/^(https?:|mailto:)/i.test(href)) { a.setAttribute('rel', 'noopener noreferrer'); a.setAttribute('target', '_blank'); continue }
      const span = document.createElement('span')
      span.append(...Array.from(a.childNodes))
      a.replaceWith(span)
    }
    await Promise.all(Array.from(content.querySelectorAll('img')).map(async img => {
      const src = img.getAttribute('src') ?? ''
      if (src.startsWith('data:')) return
      const data = await toDataUrl(img.src)
      if (data) img.setAttribute('src', data)
      else img.remove()
    }))
    // Les attributs d'evenement n'ont rien a faire sur une page publique.
    for (const el of Array.from(content.querySelectorAll('*'))) {
      for (const attr of Array.from(el.attributes)) {
        if (/^on/i.test(attr.name) || /^data-testid$/i.test(attr.name) || /^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name)
      }
    }
    const first = Array.from(content.querySelectorAll('p')).map(p => p.textContent?.trim() ?? '').find(t => t.length > 0) ?? ''
    return { html: content.outerHTML, description: first.length > 200 ? `${first.slice(0, 197)}…` : first }
  } finally {
    host.remove()
  }
}
