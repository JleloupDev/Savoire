// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Ce que la vue d'une base donne a ses dispositions (liste, galerie,
// calendrier, frise, graphique, formulaire) : le moteur, les colonnes
// visibles, l'affichage des cellules, et les ecritures.
import type { IQueryEngine, PropertyValue, QueryRow } from '@savoire/plugin-api'
import type { CellContext } from '../cells'
import { linkTarget, renderValue } from '../cells'
import { h } from '../dom'
import type { TableColumn } from '../table'

export interface LayoutHost {
  engine: IQueryEngine
  readOnly(): boolean
  /** Colonnes visibles de la vue (le titre compris). */
  columns(): TableColumn[]
  cells(): CellContext
  /** Valeur d'une colonne pour une ligne (formules et rollups calcules). */
  valueOf(row: QueryRow, key: string): PropertyValue | undefined
  open(row: QueryRow): void
  edit(row: QueryRow, key: string, value: PropertyValue): void
  addPage(values: Record<string, PropertyValue>, title?: string): void | Promise<void>
  /** Adresse affichable d'une image du vault ([[image.png]], chemin) ou du web. */
  imageUrl?(ref: string): Promise<string | null>
}

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i

/** L'image de couverture d'une ligne : la premiere image de la propriete `key`. */
export function coverRef(value: PropertyValue | undefined): string | null {
  if (value === null || value === undefined || value === '') return null
  for (const v of Array.isArray(value) ? value : [value]) {
    const s = String(v).trim()
    if (/^https?:\/\//i.test(s)) return s
    const t = linkTarget(s)
    if (IMAGE_RE.test(t)) return t
  }
  return null
}

/** Pose une couverture dans `into` (rien si la ligne n'en a pas). */
export function fillCover(host: LayoutHost, into: HTMLElement, value: PropertyValue | undefined): void {
  const ref = coverRef(value)
  if (!ref) { into.hidden = true; return }
  into.hidden = false
  const set = (url: string | null) => {
    if (!url) { into.hidden = true; return }
    const img = h('img', { class: 'base-cover-img', alt: '', loading: 'lazy', 'data-testid': 'base-cover' })
    img.src = url
    into.replaceChildren(img)
  }
  if (/^https?:\/\//i.test(ref)) set(ref)
  else if (host.imageUrl) void host.imageUrl(ref).then(set, () => set(null))
  else into.hidden = true
}

/** Les champs d'une carte ou d'une ligne de liste : colonnes visibles non vides, hors titre. */
export function cardFields(host: LayoutHost, row: QueryRow, max: number, skip: readonly string[] = []): HTMLElement[] {
  const ctx = host.cells()
  const out: HTMLElement[] = []
  for (const col of host.columns()) {
    if (col.key === '@title' || skip.includes(col.key)) continue
    const v = host.valueOf(row, col.key)
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) continue
    const type = col.formula || col.formulaError ? (col.resultType ?? (typeof v === 'number' ? 'number' : Array.isArray(v) ? 'multiselect' : typeof v === 'boolean' ? 'checkbox' : 'text')) : col.type
    out.push(h('span', { class: 'base-field', title: col.label, 'data-key': col.key }, renderValue(type, v, ctx, col.resultKey ?? col.key)))
    if (out.length >= max) break
  }
  return out
}

/** Le nom d'une ligne, cliquable s'il s'agit d'une page. */
export function titleLink(host: LayoutHost, row: QueryRow, cls: string): HTMLElement {
  const el = h(row.path ? 'a' : 'span', { class: cls, href: row.path ? '#' : undefined, 'data-testid': 'base-item-title' }, row.title || 'Sans titre')
  if (row.path) el.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); host.open(row) })
  return el
}
