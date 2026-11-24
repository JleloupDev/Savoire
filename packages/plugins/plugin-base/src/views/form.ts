// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Formulaire d'une base : un champ par colonne visible (sauf les colonnes
// calculees et les valeurs posees par l'appli), le nom en premier. Envoyer
// cree une page avec ces valeurs, puis vide le formulaire.
import { AUTO_PROPERTY_TYPES, STATUS_GROUPS } from '@savoire/plugin-api'
import type { PropertyType, PropertyValue } from '@savoire/plugin-api'
import { h } from '../dom'
import type { TableColumn } from '../table'
import type { LayoutHost } from './host'

interface Field { col: TableColumn; read(): PropertyValue | undefined; reset(): void; el: HTMLElement }

export class BaseForm {
  readonly el: HTMLElement
  private fields: Field[] = []
  private sig = ''

  constructor(private readonly host: LayoutHost, private readonly title: () => string) {
    this.el = h('div', { class: 'base-form', 'data-testid': 'base-form' })
  }

  refresh(): void {
    const cols = this.host.columns().filter(c => !c.formula && !c.formulaError && !AUTO_PROPERTY_TYPES.includes(c.type))
    const sig = JSON.stringify([cols.map(c => [c.key, c.type, c.label, this.host.cells().def?.(c.key)?.options]), this.host.readOnly(), this.title()])
    if (sig === this.sig) return
    this.sig = sig
    this.render(cols)
  }

  destroy(): void {
    this.sig = ''
    this.el.replaceChildren()
  }

  private render(cols: TableColumn[]): void {
    const ro = this.host.readOnly()
    const status = h('div', { class: 'base-form-status', 'data-testid': 'base-form-status', role: 'status' })
    this.fields = cols.map(c => this.field(c))
    const submit = h('button', { class: 'base-btn base-form-submit', type: 'submit', 'data-testid': 'base-form-submit' }, 'Envoyer')
    submit.disabled = ro
    const form = h('form', { class: 'base-form-box' },
      h('h2', { class: 'base-form-title' }, this.title()),
      ...this.fields.map(f => f.el),
      h('div', { class: 'base-pop-row' }, submit, status))
    form.addEventListener('submit', e => {
      e.preventDefault()
      if (ro) return
      const values: Record<string, PropertyValue> = {}
      let name = ''
      for (const f of this.fields) {
        const v = f.read()
        if (f.col.key === '@title') { name = typeof v === 'string' ? v.trim() : ''; continue }
        if (v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length)) values[f.col.key] = v
      }
      submit.disabled = true
      void Promise.resolve(this.host.addPage(values, name || 'Sans titre')).then(() => {
        for (const f of this.fields) f.reset()
        status.textContent = 'Envoyé, merci.'
      }, err => { status.textContent = err instanceof Error ? err.message : String(err) }).finally(() => { submit.disabled = false })
    })
    this.el.replaceChildren(form)
  }

  private field(col: TableColumn): Field {
    const id = `base-form-${col.key.replace(/[^\w-]/g, '_')}`
    const label = h('label', { class: 'base-form-label', for: id }, col.key === '@title' ? 'Nom' : col.label)
    const type: PropertyType = col.key === '@title' ? 'text' : col.type
    const options = (this.host.cells().def?.(col.key)?.options ?? []).map(o => o.value)
    const wrap = (control: HTMLElement) => h('div', { class: 'base-form-field', 'data-testid': 'base-form-field', 'data-key': col.key }, label, control)
    if (type === 'checkbox') {
      const box = h('input', { type: 'checkbox', id })
      return { col, el: wrap(box), read: () => box.checked, reset: () => { box.checked = false } }
    }
    if (type === 'select' || type === 'status' || type === 'person') {
      const choices: [string, string][] = type === 'person'
        ? this.host.cells().members.map(m => [m.id, m.name])
        : type === 'status'
          ? STATUS_GROUPS.flatMap(g => (this.host.cells().def?.(col.key)?.options ?? []).filter(o => (o.group ?? 'todo') === g.group).map(o => [o.value, o.value] as [string, string]))
          : options.map(o => [o, o])
      const sel = h('select', { class: 'base-input', id }, h('option', { value: '' }, '—'), ...choices.map(([v, l]) => h('option', { value: v }, l)))
      return { col, el: wrap(sel), read: () => sel.value || null, reset: () => { sel.value = '' } }
    }
    if (type === 'multiselect' && options.length) {
      const boxes = options.map(o => ({ o, box: h('input', { type: 'checkbox', value: o }) }))
      const list = h('div', { class: 'base-form-choices', id }, ...boxes.map(b => h('label', { class: 'base-pop-row' }, b.box, b.o)))
      return { col, el: wrap(list), read: () => boxes.filter(b => b.box.checked).map(b => b.o), reset: () => { for (const b of boxes) b.box.checked = false } }
    }
    const input = col.key === '@title' || type === 'text'
      ? h('textarea', { class: 'base-input', id, rows: col.key === '@title' ? '1' : '3' })
      : h('input', { class: 'base-input', id })
    if (input instanceof HTMLInputElement) {
      input.type = type === 'number' ? 'number' : type === 'date' ? 'date' : type === 'url' ? 'url' : type === 'email' ? 'email' : type === 'phone' ? 'tel' : 'text'
      if (type === 'multiselect' || type === 'files' || type === 'relation') input.placeholder = 'a, b, c'
    }
    if (col.key === '@title') input.setAttribute('required', '')
    const read = (): PropertyValue | undefined => {
      const raw = input.value.trim()
      if (!raw) return undefined
      if (type === 'number') { const n = Number(raw); return Number.isFinite(n) ? n : raw }
      if (type === 'multiselect' || type === 'files' || type === 'relation') {
        const items = raw.split(',').map(x => x.trim()).filter(Boolean)
        return type === 'multiselect' ? items : items.map(x => /^https?:\/\//i.test(x) || x.startsWith('[[') ? x : `[[${x}]]`)
      }
      if (type === 'link') return raw.startsWith('[[') ? raw : `[[${raw}]]`
      return raw
    }
    return { col, el: wrap(input), read, reset: () => { input.value = '' } }
  }
}
