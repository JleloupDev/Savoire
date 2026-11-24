// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Liste et galerie d'une base : les lignes de la vue, suivies en direct,
// par paquets (« Voir plus »). La liste : une ligne par page, le nom puis
// quelques proprietes. La galerie : des cartes, avec une image de couverture
// prise dans une propriete.
import type { Query, QueryResult, QueryRow } from '@savoire/plugin-api'
import { h } from '../dom'
import { cardFields, fillCover, titleLink, type LayoutHost } from './host'

const STEP = { list: 100, gallery: 60 }

export interface ListOptions {
  kind: 'list' | 'gallery'
  /** Galerie : propriete de la couverture. */
  cover?: string
  size?: 'small' | 'medium' | 'large'
}

export class BaseList {
  readonly el: HTMLElement
  private readonly items: HTMLElement
  private readonly more: HTMLElement
  private readonly adder: HTMLElement
  private query: Query | null = null
  private opts: ListOptions = { kind: 'list' }
  private shown = 0
  private stop: (() => void) | null = null
  private last: QueryResult | null = null

  constructor(private readonly host: LayoutHost) {
    this.items = h('div', { class: 'base-list-items' })
    this.more = h('button', { class: 'base-tadd base-tmore', type: 'button', 'data-testid': 'base-list-more' })
    this.more.addEventListener('click', () => { this.shown += STEP[this.opts.kind]; this.follow() })
    this.adder = h('button', { class: 'base-tadd', type: 'button', 'data-testid': 'base-list-add' }, '+ Nouvelle page')
    this.adder.addEventListener('click', () => void this.host.addPage({}))
    this.el = h('div', { class: 'base-list', 'data-testid': 'base-list' }, this.items, this.more, this.adder)
  }

  setQuery(query: Query, opts: ListOptions, force = false): void {
    const same = this.query && JSON.stringify([this.query, this.opts]) === JSON.stringify([query, opts])
    if (same && !force) return
    const kindChanged = this.opts.kind !== opts.kind
    this.query = query
    this.opts = opts
    if (kindChanged || !this.shown) this.shown = STEP[opts.kind]
    this.el.className = opts.kind === 'gallery' ? `base-list base-gallery base-gallery-${opts.size ?? 'medium'}` : 'base-list'
    this.el.dataset.testid = opts.kind === 'gallery' ? 'base-gallery' : 'base-list'
    this.follow()
  }

  private follow(): void {
    this.stop?.()
    const q = this.query
    if (!q) return
    this.stop = this.host.engine.watch({ ...q, limit: Math.min(500, this.shown) }, r => { this.last = r; this.render() })
  }

  refresh(): void {
    this.render()
  }

  destroy(): void {
    this.stop?.()
    this.stop = null
    this.query = null
    this.last = null
    this.items.replaceChildren()
  }

  private render(): void {
    const r = this.last
    this.adder.hidden = this.host.readOnly()
    if (!r) return
    this.items.replaceChildren(...r.rows.map(row => this.opts.kind === 'gallery' ? this.card(row) : this.line(row)))
    this.more.hidden = r.total <= r.rows.length
    this.more.textContent = `Voir plus (${r.total - r.rows.length} de plus)`
  }

  private line(row: QueryRow): HTMLElement {
    return h('div', { class: 'base-list-item', 'data-testid': 'base-list-item', 'data-id': row.id },
      h('span', { class: 'base-kind' }, row.path ? '📄' : '·'),
      titleLink(this.host, row, 'base-list-title'),
      h('span', { class: 'base-list-fields' }, ...cardFields(this.host, row, 5)))
  }

  private card(row: QueryRow): HTMLElement {
    const cover = h('div', { class: 'base-card-cover' })
    if (this.opts.cover) fillCover(this.host, cover, this.host.valueOf(row, this.opts.cover))
    else cover.hidden = true
    const card = h('div', { class: 'base-gallery-card', 'data-testid': 'base-gallery-card', 'data-id': row.id },
      cover,
      h('div', { class: 'base-gallery-body' },
        titleLink(this.host, row, 'base-card-title'),
        ...cardFields(this.host, row, 4, this.opts.cover ? [this.opts.cover] : []).map(f => h('div', { class: 'base-card-field' }, f))))
    card.addEventListener('click', () => { if (row.path) this.host.open(row) })
    return card
  }
}
