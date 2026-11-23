// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Blocs d'une page Notion (API) -> document d'une page Savoire (JSON
// ProseMirror, schema de plugin-page). Voir ADR-035. Pur : les blocs arrivent
// avec leurs enfants deja lus, les fichiers deja telecharges (fileOf).
//
// Correspondances :
//   paragraph, heading_1..3, listes, to_do, quote, code, divider : leurs
//     equivalents directs ; un titre repliable devient un bloc repliable ;
//   callout -> encadre (icone, couleur) ; toggle -> bloc repliable ;
//   image -> image (piece jointe du vault, ou adresse externe) ;
//   table -> tableau ; child_page, child_database, link_to_page -> carte de
//     sous-page ; video, audio, pdf, file -> carte vers la piece jointe ;
//   column_list -> les colonnes l'une apres l'autre ; synced_block -> son
//     contenu ; bookmark, embed -> un lien ; equation -> bloc de code latex ;
//   table_of_contents, breadcrumb : rien (l'application a son plan).
// Le reste devient une ligne « Bloc Notion non importé », comptee dans le
// rapport : la personne voit ou il manque quelque chose.
//
// Texte : gras, italique, barre, code, liens ; un fond de couleur devient un
// surlignage de la meme couleur. Le souligne et la couleur du texte n'existent
// pas dans une page : ils sont perdus. Un lien ou une mention vers une page
// importee devient un lien vers le document du vault.

/** Noeud ProseMirror en JSON (meme forme que PmJson de plugin-page). */
export interface PageNode {
  type: string
  attrs?: Record<string, unknown>
  content?: PageNode[]
  marks?: { type: string; attrs?: Record<string, unknown> }[]
  text?: string
}

export interface NotionRichText {
  type?: string
  plain_text?: string
  href?: string | null
  annotations?: {
    bold?: boolean
    italic?: boolean
    strikethrough?: boolean
    underline?: boolean
    code?: boolean
    color?: string
  }
  text?: { content?: string; link?: { url?: string } | null }
  mention?: {
    type?: string
    page?: { id?: string }
    database?: { id?: string }
    data_source?: { id?: string }
    link_preview?: { url?: string }
    link_mention?: { href?: string }
  }
  equation?: { expression?: string }
}

/** Un bloc tel que l'API le rend, avec ses enfants (lus a part). */
export interface NotionBlock {
  id: string
  type: string
  has_children?: boolean
  children?: NotionBlock[]
  [key: string]: unknown
}

export interface PageConvertContext {
  /**
   * Cible d'un lien vers une page ou une base Notion importee : chemin du
   * vault, sans extension pour une page, avec pour un autre document. Null :
   * pas dans l'import.
   */
  linkTarget(notionId: string): string | null
  /** Chemin dans le vault du fichier de ce bloc, deja telecharge. Null : aucun. */
  fileOf(blockId: string): string | null
}

export interface PageConvertResult {
  doc: PageNode
  /** Blocs non importes, par type. */
  unsupported: Record<string, number>
}

/** Identifiant Notion sans tirets, en minuscules. */
export function normalizeId(id: string): string {
  return id.replace(/-/g, '').toLowerCase()
}

/**
 * Identifiant de page dans une adresse Notion (« /0123… », « https://www.notion.so/Titre-0123… »).
 * Null si l'adresse ne vise pas Notion.
 */
export function notionIdFromUrl(url: string): string | null {
  const rel = /^\/([0-9a-f]{32})(?:[?#].*)?$/i.exec(url)
  if (rel) return rel[1].toLowerCase()
  let u: URL
  try { u = new URL(url) } catch { return null }
  if (!/(^|\.)notion\.(so|site|com)$/i.test(u.hostname)) return null
  const last = u.pathname.split('/').filter(Boolean).at(-1) ?? ''
  const m = /([0-9a-f]{32})$/i.exec(last.replace(/-/g, '')) ?? /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(last)
  return m ? normalizeId(m[1]) : null
}

/** Couleur de surlignage d'une couleur de fond Notion, ou null. */
export function highlightColorOf(color: string | undefined): string | null {
  const m = /^([a-z]+)_background$/.exec(color ?? '')
  return m ? NOTION_TO_PAGE_COLOR[m[1]] ?? null : null
}

/** Couleurs de Notion -> les six de l'application. */
export const NOTION_TO_PAGE_COLOR: Record<string, string> = {
  red: 'red', pink: 'purple', orange: 'orange', brown: 'orange', yellow: 'yellow', green: 'green', blue: 'blue', purple: 'purple',
}

/** Couleur d'un encadre (fond ou texte de Notion). */
function calloutColor(color: string | undefined): string {
  const name = (color ?? '').replace(/_background$/, '')
  if (name === 'gray') return 'gray'
  return NOTION_TO_PAGE_COLOR[name] ?? 'default'
}

// ── Texte ─────────────────────────────────────────────────────────────────

/** Texte brut d'un texte riche. */
export function plainText(rt: readonly NotionRichText[] | undefined): string {
  return (rt ?? []).map(t => t.plain_text ?? t.text?.content ?? '').join('')
}

function hrefOf(t: NotionRichText, ctx: PageConvertContext): string | null {
  const m = t.mention
  if (t.type === 'mention' && m) {
    const id = m.page?.id ?? m.database?.id ?? m.data_source?.id
    if (id) return ctx.linkTarget(normalizeId(id))
    const url = m.link_preview?.url ?? m.link_mention?.href
    if (url) return url
    return null
  }
  const url = t.text?.link?.url ?? t.href ?? null
  if (!url) return null
  const id = notionIdFromUrl(url)
  if (id) return ctx.linkTarget(id) ?? (url.startsWith('/') ? `https://www.notion.so${url}` : url)
  return url
}

/** Texte riche -> noeuds en ligne (texte avec marques, retours a la ligne). */
export function richTextToInline(rt: readonly NotionRichText[] | undefined, ctx: PageConvertContext): PageNode[] {
  const out: PageNode[] = []
  for (const t of rt ?? []) {
    const raw = t.type === 'equation' ? (t.equation?.expression ?? t.plain_text ?? '') : (t.plain_text ?? t.text?.content ?? '')
    if (!raw) continue
    const a = t.annotations ?? {}
    const marks: NonNullable<PageNode['marks']> = []
    if (a.bold) marks.push({ type: 'bold' })
    if (a.italic) marks.push({ type: 'italic' })
    if (a.strikethrough) marks.push({ type: 'strike' })
    if (a.code || t.type === 'equation') marks.push({ type: 'code' })
    const hl = highlightColorOf(a.color)
    if (hl) marks.push({ type: 'highlight', attrs: { color: hl } })
    const href = hrefOf(t, ctx)
    if (href) marks.push({ type: 'link', attrs: { href } })
    raw.split('\n').forEach((part, i) => {
      if (i > 0) out.push({ type: 'hardBreak' })
      if (part) out.push(marks.length ? { type: 'text', text: part, marks: marks.map(m => ({ ...m })) } : { type: 'text', text: part })
    })
  }
  return out
}

// ── Blocs ─────────────────────────────────────────────────────────────────

const LIST_KINDS: Record<string, 'bulletList' | 'orderedList' | 'taskList'> = {
  bulleted_list_item: 'bulletList',
  numbered_list_item: 'orderedList',
  to_do: 'taskList',
}

type Data = { rich_text?: NotionRichText[]; caption?: NotionRichText[]; color?: string; [k: string]: unknown }

function dataOf(b: NotionBlock): Data {
  return (b[b.type] as Data | undefined) ?? {}
}

function paragraph(inline: PageNode[]): PageNode {
  return inline.length ? { type: 'paragraph', content: inline } : { type: 'paragraph' }
}

function textParagraph(text: string, italic = false): PageNode {
  return { type: 'paragraph', content: [italic ? { type: 'text', text, marks: [{ type: 'italic' }] } : { type: 'text', text }] }
}

function linkParagraph(label: string, href: string): PageNode {
  return { type: 'paragraph', content: [{ type: 'text', text: label || href, marks: [{ type: 'link', attrs: { href } }] }] }
}

/** Adresse d'un fichier Notion : { type: 'file', file: { url } } ou { type: 'external', external: { url } }. */
function fileUrl(d: Data): { kind: 'file' | 'external' | 'file_upload'; url: string } | null {
  const kind = d.type as string | undefined
  if (kind === 'external') {
    const url = (d.external as { url?: string } | undefined)?.url
    return url ? { kind, url } : null
  }
  if (kind === 'file' || kind === 'file_upload') {
    const url = (d.file as { url?: string } | undefined)?.url ?? ''
    return { kind, url }
  }
  return null
}

class Converter {
  readonly unsupported: Record<string, number> = {}

  constructor(private readonly ctx: PageConvertContext) {}

  private skip(type: string): PageNode {
    this.unsupported[type] = (this.unsupported[type] ?? 0) + 1
    return textParagraph(`Bloc Notion non importé (${type}).`, true)
  }

  blocks(list: readonly NotionBlock[]): PageNode[] {
    const out: PageNode[] = []
    let i = 0
    while (i < list.length) {
      const b = list[i]
      const kind = LIST_KINDS[b.type]
      if (kind) {
        const items: PageNode[] = []
        while (i < list.length && LIST_KINDS[list[i].type] === kind) items.push(this.listItem(list[i++], kind))
        out.push({ type: kind, content: items })
        continue
      }
      out.push(...this.block(b))
      i++
    }
    return out
  }

  private inline(rt: NotionRichText[] | undefined): PageNode[] {
    return richTextToInline(rt, this.ctx)
  }

  private children(b: NotionBlock): PageNode[] {
    return this.blocks(b.children ?? [])
  }

  private listItem(b: NotionBlock, kind: string): PageNode {
    const d = dataOf(b)
    const content = [paragraph(this.inline(d.rich_text)), ...this.children(b)]
    if (kind === 'taskList') return { type: 'taskItem', attrs: { checked: d.checked === true }, content }
    return { type: 'listItem', content }
  }

  private card(target: string | null, label: string): PageNode {
    return target ? { type: 'pageLink', attrs: { target } } : textParagraph(label)
  }

  private block(b: NotionBlock): PageNode[] {
    const d = dataOf(b)
    switch (b.type) {
      case 'paragraph':
        return [paragraph(this.inline(d.rich_text)), ...this.children(b)]
      case 'heading_1': case 'heading_2': case 'heading_3': {
        const level = Number(b.type.slice(-1))
        const inline = this.inline(d.rich_text)
        if (d.is_toggleable) {
          return [{ type: 'toggle', attrs: { heading: level }, content: [{ type: 'toggleTitle', ...(inline.length ? { content: inline } : {}) }, ...this.children(b)] }]
        }
        return [{ type: 'heading', attrs: { level }, ...(inline.length ? { content: inline } : {}) }, ...this.children(b)]
      }
      case 'toggle': {
        const inline = this.inline(d.rich_text)
        return [{ type: 'toggle', content: [{ type: 'toggleTitle', ...(inline.length ? { content: inline } : {}) }, ...this.children(b)] }]
      }
      case 'quote':
        return [{ type: 'blockquote', content: [paragraph(this.inline(d.rich_text)), ...this.children(b)] }]
      case 'callout': {
        const icon = d.icon as { type?: string; emoji?: string } | undefined
        const inline = this.inline(d.rich_text)
        const content = [...(inline.length ? [paragraph(inline)] : []), ...this.children(b)]
        return [{
          type: 'callout',
          attrs: { icon: icon?.type === 'emoji' && icon.emoji ? icon.emoji : '💡', color: calloutColor(d.color) },
          content: content.length ? content : [paragraph([])],
        }]
      }
      case 'code': {
        const code = plainText(d.rich_text)
        const language = typeof d.language === 'string' && d.language !== 'plain text' ? d.language : null
        return [{ type: 'codeBlock', attrs: { language }, ...(code ? { content: [{ type: 'text', text: code }] } : {}) }]
      }
      case 'equation': {
        const expr = String(d.expression ?? '')
        return [{ type: 'codeBlock', attrs: { language: 'latex' }, ...(expr ? { content: [{ type: 'text', text: expr }] } : {}) }]
      }
      case 'divider':
        return [{ type: 'horizontalRule' }]
      case 'image': {
        const f = fileUrl(d)
        const alt = plainText(d.caption)
        const src = f?.kind === 'external' ? f.url : this.ctx.fileOf(b.id)
        if (!src) return [textParagraph('Image indisponible.', true)]
        return [{ type: 'image', attrs: { src, alt } }]
      }
      case 'video': case 'audio': case 'pdf': case 'file': {
        const f = fileUrl(d)
        const name = String(d.name ?? '') || plainText(d.caption)
        if (f?.kind === 'external') return [linkParagraph(name, f.url)]
        const path = this.ctx.fileOf(b.id)
        return [path ? { type: 'pageLink', attrs: { target: path } } : textParagraph(`Fichier indisponible${name ? ` : ${name}` : ''}.`, true)]
      }
      case 'bookmark': case 'embed': case 'link_preview': {
        const url = String(d.url ?? '')
        if (!url) return []
        return [linkParagraph(plainText(d.caption), url)]
      }
      case 'child_page':
        return [this.card(this.ctx.linkTarget(normalizeId(b.id)), String(d.title ?? 'Page'))]
      case 'child_database':
        return [this.card(this.ctx.linkTarget(normalizeId(b.id)), String(d.title ?? 'Base'))]
      case 'link_to_page': {
        const id = (d.page_id ?? d.database_id ?? d.data_source_id) as string | undefined
        return id ? [this.card(this.ctx.linkTarget(normalizeId(id)), 'Page Notion')] : []
      }
      case 'table':
        return [this.table(b, d)]
      case 'column_list':
        return (b.children ?? []).flatMap(col => this.children(col))
      case 'column': case 'synced_block':
        return this.children(b)
      case 'table_of_contents': case 'breadcrumb':
        return []
      default:
        return [this.skip(b.type)]
    }
  }

  private table(b: NotionBlock, d: Data): PageNode {
    const colHeader = d.has_column_header === true
    const rowHeader = d.has_row_header === true
    const rows = (b.children ?? []).filter(r => r.type === 'table_row')
    const width = Math.max(1, Number(d.table_width) || 0, ...rows.map(r => ((dataOf(r).cells as unknown[]) ?? []).length))
    const content = rows.map((r, ri) => {
      const cells = (dataOf(r).cells as NotionRichText[][] | undefined) ?? []
      return {
        type: 'tableRow',
        content: Array.from({ length: width }, (_, ci) => ({
          type: 'tableCell',
          attrs: { header: (colHeader && ri === 0) || (rowHeader && ci === 0) },
          content: [paragraph(this.inline(cells[ci]))],
        })),
      }
    })
    if (!content.length) return paragraph([])
    return { type: 'table', content }
  }
}

/** Blocs d'une page -> document de page. Un document vide garde un paragraphe. */
export function notionBlocksToPage(blocks: readonly NotionBlock[], ctx: PageConvertContext): PageConvertResult {
  const c = new Converter(ctx)
  const content = c.blocks(blocks)
  return { doc: { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] }, unsupported: c.unsupported }
}

/**
 * Les blocs qui portent un fichier a telecharger (images, videos, PDF...
 * envoyes dans Notion), enfants compris.
 */
export function blocksWithFiles(blocks: readonly NotionBlock[]): { block: NotionBlock; url: string; name: string }[] {
  const out: { block: NotionBlock; url: string; name: string }[] = []
  const walk = (list: readonly NotionBlock[]) => {
    for (const b of list) {
      if (['image', 'video', 'audio', 'pdf', 'file'].includes(b.type)) {
        const d = dataOf(b)
        const f = fileUrl(d)
        if (f && f.kind !== 'external' && f.url) out.push({ block: b, url: f.url, name: fileNameOf(f.url, String(d.name ?? ''), b.type) })
      }
      if (b.children?.length) walk(b.children)
    }
  }
  walk(blocks)
  return out
}

/** Nom d'un fichier : celui donne dans Notion, sinon la fin de l'adresse. */
export function fileNameOf(url: string, given: string, type: string): string {
  const clean = (s: string) => s.replace(/[\\/:*?"<>|#^[\]]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (given && /\.[a-z0-9]{2,5}$/i.test(given)) return clean(given)
  let last = ''
  try { last = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).at(-1) ?? '') } catch { /* adresse illisible */ }
  const name = clean(last)
  if (name && /\.[a-z0-9]{2,5}$/i.test(name)) return name
  const ext = type === 'image' ? 'png' : type === 'pdf' ? 'pdf' : type === 'video' ? 'mp4' : type === 'audio' ? 'mp3' : 'bin'
  return `${clean(given) || type}.${ext}`
}
