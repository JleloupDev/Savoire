// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Apercu lateral d'une ligne, comme le « side peek » de Notion : son nom,
// toutes ses proprietes (modifiables), le debut de sa note, et un bouton
// pour l'ouvrir en grand. Pose sur le cote droit de la vue de la base.
import { AUTO_PROPERTY_TYPES } from '@savoire/plugin-api'
import type { PropertyType, PropertyValue, QueryRow } from '@savoire/plugin-api'
import { openEditor, renderValue, type CellContext } from './cells'
import { h } from './dom'
import type { TableColumn } from './table'

export interface PeekHost {
  /** Toutes les colonnes de la base (le nom compris). */
  columns(): TableColumn[]
  cells(): CellContext
  readOnly(): boolean
  typeOf(key: string): PropertyType
  label(key: string): string
  valueOf(row: QueryRow, key: string): PropertyValue | undefined
  edit(row: QueryRow, key: string, value: PropertyValue): void
  rename(row: QueryRow, title: string): void
  open(row: QueryRow): void
  /** Texte de la note (sans proprietes) ; null : ligne legere ou illisible. */
  readBody?(row: QueryRow): Promise<string | null>
}

/** Le texte d'une note sans son bloc de proprietes. */
export function stripFrontmatter(md: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(md)
  return (m ? md.slice(m[0].length) : md).trim()
}

export class RowPeek {
  readonly el: HTMLElement
  private row: QueryRow | null = null
  private editing = false
  private seq = 0

  constructor(private readonly host: PeekHost, private readonly onClose: () => void) {
    this.el = h('aside', { class: 'base-peek', 'data-testid': 'base-peek-panel' })
    this.el.hidden = true
    this.el.addEventListener('keydown', e => { if (e.key === 'Escape' && !this.editing) { e.stopPropagation(); this.hide() } })
  }

  get current(): QueryRow | null {
    return this.row
  }

  show(row: QueryRow): void {
    this.row = row
    this.el.hidden = false
    this.render(true)
  }

  /** La ligne a change ailleurs (index) : on redessine, sauf pendant une saisie. */
  update(row: QueryRow | undefined): void {
    if (!this.row || !row || row.id !== this.row.id || this.editing) return
    if (JSON.stringify(row) === JSON.stringify(this.row)) return
    this.row = row
    this.render(false)
  }

  hide(): void {
    this.row = null
    this.el.hidden = true
    this.el.replaceChildren()
    this.onClose()
  }

  private render(withBody: boolean): void {
    const row = this.row
    if (!row) return
    const ro = this.host.readOnly()
    const close = h('button', { class: 'base-btn', type: 'button', title: 'Fermer', 'data-testid': 'base-peek-close' }, '×')
    close.addEventListener('click', () => this.hide())
    const open = row.path ? h('button', { class: 'base-btn', type: 'button', 'data-testid': 'base-peek-open' }, 'Ouvrir la page') : null
    open?.addEventListener('click', () => this.host.open(row))
    const title = h('input', { class: 'base-peek-title', 'data-testid': 'base-peek-title' })
    title.value = row.title
    title.disabled = ro
    title.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') title.blur() })
    title.addEventListener('change', () => { const t = title.value.trim(); if (t && t !== row.title) this.host.rename(row, t) })
    const props = h('div', { class: 'base-peek-props' })
    const ctx = this.host.cells()
    const keys = new Set<string>()
    const lines: HTMLElement[] = []
    const add = (key: string, col?: TableColumn) => {
      if (keys.has(key) || key === '@title') return
      keys.add(key)
      const computed = !!(col?.formula || col?.formulaError)
      const type = col ? (computed ? (col.resultType ?? 'text') : col.type) : this.host.typeOf(key)
      const value = this.host.valueOf(row, key)
      const cell = h('div', { class: 'base-peek-value', tabindex: '-1', 'data-key': key })
      cell.append(renderValue(type, value ?? null, ctx, col?.resultKey ?? key))
      const editable = !ro && !computed && !AUTO_PROPERTY_TYPES.includes(type)
      if (editable) {
        cell.classList.add('base-peek-editable')
        const start = () => {
          if (this.editing) return
          if (type === 'checkbox') { this.host.edit(row, key, !(value === true || value === 'true')); return }
          this.editing = true
          openEditor(cell, key, type, value ?? null, ctx, v => {
            this.editing = false
            if (JSON.stringify(v) !== JSON.stringify(value ?? null)) this.host.edit(row, key, v)
            this.render(false)
          }, () => { this.editing = false; this.render(false) })
        }
        cell.addEventListener('click', start)
        cell.addEventListener('keydown', e => { if (e.key === 'Enter') start() })
      }
      lines.push(h('div', { class: 'base-peek-row', 'data-testid': 'base-peek-row' },
        h('span', { class: 'base-peek-label' }, col?.label ?? this.host.label(key)), cell))
    }
    for (const col of this.host.columns()) add(col.key, col)
    for (const key of Object.keys(row.values)) add(key)
    props.replaceChildren(...lines)
    const body = h('div', { class: 'base-peek-body', 'data-testid': 'base-peek-body' })
    const previous = this.el.querySelector('.base-peek-body')
    if (!withBody && previous) body.replaceChildren(...Array.from(previous.childNodes))
    this.el.replaceChildren(
      h('div', { class: 'base-peek-head' }, open, h('span', { class: 'base-spacer' }), close),
      title, props, body)
    if (withBody && this.host.readBody) {
      const n = ++this.seq
      body.textContent = '…'
      void this.host.readBody(row).then(text => {
        if (n !== this.seq) return
        body.textContent = text === null ? '' : text ? stripFrontmatter(text).slice(0, 4000) : ''
        if (text !== null && !stripFrontmatter(text)) body.append(h('span', { class: 'base-hint' }, 'Page vide.'))
      }, () => { body.textContent = '' })
    }
  }
}
