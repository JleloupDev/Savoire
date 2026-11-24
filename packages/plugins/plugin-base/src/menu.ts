// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Menu de choix flottant d'une cellule (choix, choix multiple, statut,
// personne, relation) : la saisie reste dans la cellule, la liste flotte
// dessous, hors du tableau (une cellule coupe ce qui deborde). Fleches pour
// se deplacer, Entree pour choisir ou creer, Echap pour annuler. En choix
// multiple, un clic coche ou decoche et le menu reste ouvert ; on valide en
// le quittant.
import { h } from './dom'

export interface MenuItem {
  value: string
  label: string
  color?: string
  /** Groupe d'affichage (statut : a faire, en cours, termine). */
  group?: string
  /** Texte discret a droite (dossier d'une ligne liee...). */
  hint?: string
}

export interface ChoiceMenuOptions {
  /** Ou poser la liste (sous cet element). */
  anchor: HTMLElement
  /** Saisie de recherche, deja dans la cellule. */
  input: HTMLInputElement
  /** Elements proposes pour un texte saisi (filtre compris). */
  items(text: string): MenuItem[] | Promise<MenuItem[]>
  multiple: boolean
  selected: string[]
  /** Un texte qui ne correspond a rien devient une valeur. */
  allowCreate: boolean
  /** Titres des groupes, dans l'ordre. */
  groups?: { id: string; label: string }[]
  /** Valeurs choisies (null : annule). */
  done(values: string[] | null): void
  /** Les valeurs choisies ont change (choix multiple) : redessiner les pastilles. */
  changed?(values: string[]): void
}

export interface ChoiceMenu {
  readonly el: HTMLElement
  values(): string[]
  close(commit: boolean): void
}

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/** Filtre une liste d'elements sur un texte (sans casse ni accents). */
export function filterItems(items: MenuItem[], text: string): MenuItem[] {
  const t = fold(text.trim())
  return t ? items.filter(i => fold(i.label).includes(t) || fold(i.value).includes(t)) : items
}

export function colorClass(color: string | undefined): string {
  return color ? ` base-color-${color.replace(/[^a-z]/g, '')}` : ''
}

export function openChoiceMenu(opts: ChoiceMenuOptions): ChoiceMenu {
  const selected = [...opts.selected]
  const el = h('div', { class: 'base-choice-menu', 'data-testid': 'base-choice-menu', role: 'listbox' })
  // La saisie garde le focus quand on clique dans la liste.
  el.addEventListener('mousedown', e => e.preventDefault())
  document.body.appendChild(el)
  let items: MenuItem[] = []
  let active = 0
  let closed = false
  let seq = 0

  const place = () => {
    const r = opts.anchor.getBoundingClientRect()
    const below = (typeof window !== 'undefined' ? window.innerHeight : 800) - r.bottom
    el.style.left = `${Math.max(4, r.left)}px`
    el.style.minWidth = `${Math.max(200, r.width)}px`
    if (below < 240 && r.top > below) { el.style.top = ''; el.style.bottom = `${(typeof window !== 'undefined' ? window.innerHeight : 800) - r.top + 2}px` }
    else { el.style.bottom = ''; el.style.top = `${r.bottom + 2}px` }
  }

  const text = () => opts.input.value.trim()
  const exact = () => items.find(i => fold(i.value) === fold(text()))

  const render = () => {
    const rows: HTMLElement[] = []
    let lastGroup: string | undefined
    const groupLabel = (id: string) => opts.groups?.find(g => g.id === id)?.label ?? id
    items.forEach((item, i) => {
      if (opts.groups && item.group !== lastGroup) {
        lastGroup = item.group
        rows.push(h('div', { class: 'base-choice-group' }, groupLabel(item.group ?? '')))
      }
      const on = selected.includes(item.value)
      const row = h('div', {
        class: `base-choice-item${i === active ? ' base-choice-active' : ''}`, role: 'option',
        'data-testid': 'base-choice', 'data-value': item.value, 'aria-selected': on ? 'true' : 'false',
      },
      opts.multiple ? h('span', { class: 'base-choice-check' }, on ? '☑' : '☐') : null,
      h('span', { class: `base-pill${colorClass(item.color)}` }, item.label),
      item.hint ? h('span', { class: 'base-choice-hint' }, item.hint) : null)
      row.addEventListener('mouseenter', () => { active = i; for (const r of Array.from(el.querySelectorAll('.base-choice-active'))) r.classList.remove('base-choice-active'); row.classList.add('base-choice-active') })
      row.addEventListener('click', () => pick(item.value))
      rows.push(row)
    })
    const t = text()
    if (opts.allowCreate && t && !exact()) {
      const create = h('div', { class: `base-choice-item base-choice-create${active === items.length ? ' base-choice-active' : ''}`, 'data-testid': 'base-choice-create' },
        'Créer ', h('span', { class: 'base-pill' }, t))
      create.addEventListener('click', () => pick(t))
      rows.push(create)
    }
    if (!rows.length) rows.push(h('div', { class: 'base-choice-empty' }, t ? 'Aucun résultat' : 'Aucune valeur'))
    el.replaceChildren(...rows)
    place()
  }

  const refresh = async () => {
    const n = ++seq
    const list = await opts.items(opts.input.value)
    if (n !== seq || closed) return
    items = list
    active = Math.min(active, Math.max(0, items.length - 1))
    render()
  }

  const close = (commit: boolean) => {
    if (closed) return
    closed = true
    el.remove()
    document.removeEventListener('mousedown', outside, true)
    if (!commit) { opts.done(null); return }
    if (!opts.multiple) {
      // Quitter avec un texte saisi : la valeur correspondante, ou une nouvelle.
      const t = text()
      const match = exact()
      if (match) opts.done([match.value])
      else if (t && opts.allowCreate) opts.done([t])
      else if (!t && opts.selected.length) opts.done([])
      else opts.done(null)
      return
    }
    opts.done(selected)
  }

  function pick(value: string) {
    if (!opts.multiple) {
      closed = true
      el.remove()
      document.removeEventListener('mousedown', outside, true)
      opts.done([value])
      return
    }
    const i = selected.indexOf(value)
    if (i >= 0) selected.splice(i, 1)
    else selected.push(value)
    opts.changed?.([...selected])
    opts.input.value = ''
    void refresh()
  }

  function outside(e: MouseEvent) {
    const t = e.target as Node
    if (el.contains(t) || opts.input.contains(t) || opts.anchor.contains(t)) return
    close(true)
  }
  document.addEventListener('mousedown', outside, true)

  opts.input.addEventListener('input', () => { active = 0; void refresh() })
  // Tab ou focus ailleurs : on valide.
  opts.input.addEventListener('blur', () => setTimeout(() => { if (!closed && document.activeElement !== opts.input) close(true) }, 0))
  opts.input.addEventListener('keydown', e => {
    const k = (e as KeyboardEvent).key
    e.stopPropagation()
    const count = items.length + (opts.allowCreate && text() && !exact() ? 1 : 0)
    if (k === 'ArrowDown') { e.preventDefault(); active = Math.min(count - 1, active + 1); render() }
    else if (k === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); render() }
    else if (k === 'Escape') { e.preventDefault(); close(false) }
    else if (k === 'Enter') {
      e.preventDefault()
      const t = text()
      // Entree sur un texte qui correspond exactement : cette valeur (pas la ligne surlignee).
      const match = exact()
      if (match) { pick(match.value); if (opts.multiple) return; return }
      if (t && opts.allowCreate && (active >= items.length || !items.length || filterItems(items, t).length === 0)) { pick(t); return }
      const item = items[active]
      if (item && (t || opts.multiple)) { pick(item.value); return }
      close(true)
    } else if (k === 'Backspace' && opts.multiple && !opts.input.value && selected.length) {
      selected.pop()
      opts.changed?.([...selected])
      void refresh()
    }
  })
  void refresh()
  return { el, values: () => [...selected], close }
}
