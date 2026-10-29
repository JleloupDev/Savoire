// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Une cellule de base : son affichage et son editeur, selon le type de la
// propriete (texte, nombre, date, case, choix, choix multiple, lien,
// personne). Les memes types que le panneau des proprietes de Plume.
import { coercePropertyValue } from '@savoire/plugin-api'
import type { PropertyMember, PropertyType, PropertyValue } from '@savoire/plugin-api'

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, string>> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) continue
    if (k === 'class') el.className = v
    else if (k.startsWith('data-')) el.setAttribute(k, v)
    else el.setAttribute(k, v)
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c)
  return el
}

export interface CellContext {
  members: PropertyMember[]
  /** Valeurs proposees pour un choix. */
  knownValues(key: string): Promise<string[]>
  openLink(target: string): void
}

export function linkTarget(value: string): string {
  const m = /^\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]$/.exec(value.trim())
  return (m ? m[1] : value).trim()
}

/** Texte d'une valeur, pour un filtre ou une infobulle. */
export function valueText(value: PropertyValue | undefined): string {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.join(', ')
  if (typeof value === 'boolean') return value ? 'Oui' : 'Non'
  return String(value)
}

/** Affichage d'une valeur (lecture). */
export function renderValue(type: PropertyType, raw: PropertyValue | undefined, ctx: CellContext): Node {
  const value = coercePropertyValue(raw ?? null, type)
  if (value === null || (Array.isArray(value) && value.length === 0)) return h('span', { class: 'base-empty' })
  switch (type) {
    case 'checkbox':
      return h('span', { class: 'base-check', 'data-testid': 'base-check' }, value === true ? '☑' : '☐')
    case 'number':
      return h('span', { class: 'base-num' }, String(value))
    case 'select':
      return h('span', { class: 'base-pill' }, valueText(value))
    case 'multiselect':
      return h('span', { class: 'base-pills' }, ...(Array.isArray(value) ? value : [String(value)]).map(v => h('span', { class: 'base-pill' }, v)))
    case 'link': {
      const items = Array.isArray(value) ? value : [String(value)]
      return h('span', {}, ...items.map(v => {
        const a = h('a', { class: 'base-link', href: '#' }, linkTarget(v))
        a.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); ctx.openLink(linkTarget(v)) })
        return a
      }))
    }
    case 'person': {
      const id = valueText(value)
      return h('span', { class: 'base-person' }, ctx.members.find(m => m.id === id)?.name ?? id)
    }
    default:
      return h('span', {}, valueText(value))
  }
}

let listCounter = 0

/**
 * Editeur d'une cellule, place dans `host`. `commit` recoit la nouvelle
 * valeur (null : vide). Entree valide, Echap annule, quitter valide.
 */
export function openEditor(
  host: HTMLElement,
  key: string,
  type: PropertyType,
  raw: PropertyValue | undefined,
  ctx: CellContext,
  commit: (value: PropertyValue) => void,
  cancel: () => void,
): void {
  const value = coercePropertyValue(raw ?? null, type)
  let done = false
  const finish = (v: PropertyValue | undefined) => {
    if (done) return
    done = true
    if (v === undefined) cancel()
    else commit(v)
  }
  const keys = (el: HTMLElement, read: () => PropertyValue) => {
    el.addEventListener('keydown', e => {
      const k = (e as KeyboardEvent).key
      if (k === 'Enter') { e.preventDefault(); finish(read()) }
      if (k === 'Escape') { e.preventDefault(); finish(undefined) }
      e.stopPropagation()
    })
    el.addEventListener('blur', () => finish(read()))
  }
  if (type === 'person') {
    const select = h('select', { class: 'base-editor', 'data-testid': 'base-editor' })
    select.append(h('option', { value: '' }, '—'), ...ctx.members.map(m => h('option', { value: m.id }, m.name)))
    const id = valueText(value)
    if (id && !ctx.members.some(m => m.id === id)) select.append(h('option', { value: id }, id))
    select.value = id
    keys(select, () => select.value || null)
    select.addEventListener('change', () => finish(select.value || null))
    host.replaceChildren(select)
    select.focus()
    return
  }
  const input = h('input', { class: 'base-editor', 'data-testid': 'base-editor' })
  switch (type) {
    case 'number':
      input.type = 'number'
      input.value = value === null ? '' : String(value)
      keys(input, () => {
        if (input.value.trim() === '') return null
        const n = Number(input.value)
        return Number.isFinite(n) ? n : input.value
      })
      break
    case 'date': {
      const s = typeof value === 'string' ? value : ''
      input.type = s.includes('T') ? 'datetime-local' : 'date'
      input.value = s.includes('T') ? s.slice(0, 16) : s
      keys(input, () => input.value || null)
      break
    }
    case 'multiselect':
      input.value = Array.isArray(value) ? value.join(', ') : valueText(value)
      input.placeholder = 'a, b, c'
      keys(input, () => input.value.split(',').map(v => v.trim()).filter(Boolean))
      break
    case 'link':
      input.value = valueText(value)
      input.placeholder = '[[Note]]'
      keys(input, () => {
        const v = input.value.trim()
        return v ? (v.startsWith('[[') ? v : `[[${v}]]`) : null
      })
      break
    default:
      input.value = valueText(value)
      keys(input, () => input.value === '' ? null : input.value)
  }
  if (type === 'select' || type === 'multiselect') {
    const list = h('datalist', { id: `base-values-${++listCounter}` })
    input.setAttribute('list', list.id)
    void ctx.knownValues(key).then(values => list.replaceChildren(...values.map(v => h('option', { value: v }))))
    host.replaceChildren(input, list)
  } else {
    host.replaceChildren(input)
  }
  input.focus()
  input.select?.()
}
