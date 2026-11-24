// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Reglages d'une propriete, depuis l'en-tete de sa colonne : nom affiche,
// cle dans les notes (renommer partout dans la base), type, et ce qui depend
// du type : options et couleurs (choix, statut), format et affichage d'un
// nombre, plusieurs personnes, prefixe d'un numero, base visee d'une
// relation. Les reglages valent pour tout le vault (api.properties).
import {
  DEFAULT_STATUS_OPTIONS, NUMBER_FORMATS, PROPERTY_TYPES, PROPERTY_TYPE_INFO, STATUS_GROUPS,
} from '@savoire/plugin-api'
import type { NumberFormat, PropertyDef, PropertyOption, PropertyType, StatusGroup } from '@savoire/plugin-api'
import { h } from './cells'
import { colorClass } from './menu'

/** Couleurs des options (les memes que les pages). */
export const OPTION_COLORS: { color: string; label: string }[] = [
  { color: '', label: 'Par défaut' },
  { color: 'gray', label: 'Gris' },
  { color: 'brown', label: 'Marron' },
  { color: 'orange', label: 'Orange' },
  { color: 'yellow', label: 'Jaune' },
  { color: 'green', label: 'Vert' },
  { color: 'blue', label: 'Bleu' },
  { color: 'purple', label: 'Violet' },
  { color: 'pink', label: 'Rose' },
  { color: 'red', label: 'Rouge' },
]

export interface PropertySettingsHost {
  key: string
  editable: boolean
  def(): PropertyDef | undefined
  type(): PropertyType
  /** Valeurs vues dans les lignes (options proposees avant d'etre declarees). */
  knownValues(): Promise<string[]>
  setDef(def: PropertyDef): void
  /** Renomme la cle dans toutes les lignes de la base. */
  renameKey(next: string): Promise<void>
  /** Renomme une valeur dans toutes les lignes de la base. */
  renameValue(from: string, to: string): Promise<void>
  /** Bases du vault (relation). */
  bases(): { id: string; path: string }[]
  /** Base de la vue (relation vers elle-meme). */
  selfBase?: string
  report(err: unknown): void
}

function field(label: string, ...control: (Node | null)[]): HTMLElement {
  return h('label', { class: 'base-pop-row base-setting' }, h('span', { class: 'base-setting-label' }, label), ...control)
}

/** Le contenu de la fenetre des reglages. Se redessine a chaque changement du type. */
export function renderPropertySettings(host: PropertySettingsHost): HTMLElement {
  const box = h('div', { class: 'base-pop-list base-settings', 'data-testid': 'base-property-settings' })
  const type = host.type()
  const def: PropertyDef = { ...(host.def() ?? { key: host.key, type }), key: host.key, type }
  const save = (patch: Partial<PropertyDef>) => {
    try { host.setDef({ ...def, ...patch }) } catch (err) { host.report(err) }
  }
  const dis = (el: HTMLInputElement | HTMLSelectElement | HTMLButtonElement) => { el.disabled = !host.editable; return el }

  // Nom affiche : la cle ne change pas.
  const name = dis(h('input', { class: 'base-input', 'data-testid': 'base-setting-label', placeholder: host.key })) as HTMLInputElement
  name.value = def.label ?? ''
  name.addEventListener('change', () => save({ label: name.value.trim() || undefined }))
  box.append(field('Nom affiché', name))

  // Cle : renommer dans toutes les notes de la base.
  const key = dis(h('input', { class: 'base-input', 'data-testid': 'base-setting-key' })) as HTMLInputElement
  key.value = host.key
  const rename = dis(h('button', { class: 'base-btn', type: 'button', 'data-testid': 'base-setting-rename' }, 'Renommer')) as HTMLButtonElement
  rename.addEventListener('click', () => {
    const next = key.value.replace(/:/g, '').trim()
    if (!next || next === host.key || next.startsWith('@') || next.startsWith('=')) return
    rename.disabled = true
    void host.renameKey(next).catch(host.report)
  })
  box.append(field('Clé dans les notes', key, rename))

  const typeSelect = dis(h('select', { class: 'base-input', 'data-testid': 'base-setting-type' },
    ...PROPERTY_TYPES.map(t => h('option', { value: t }, PROPERTY_TYPE_INFO[t].label)))) as HTMLSelectElement
  typeSelect.value = type
  typeSelect.addEventListener('change', () => {
    const t = typeSelect.value as PropertyType
    // Un statut neuf part avec ses trois options.
    const options = t === 'status' && !def.options?.length ? [...DEFAULT_STATUS_OPTIONS] : def.options
    save({ type: t, ...(options ? { options } : {}) })
  })
  box.append(field('Type', typeSelect))

  if (type === 'select' || type === 'multiselect' || type === 'status') box.append(optionsEditor(host, def, save))

  if (type === 'number') {
    const format = dis(h('select', { class: 'base-input', 'data-testid': 'base-setting-format' },
      ...NUMBER_FORMATS.map(f => h('option', { value: f.format }, f.label)))) as HTMLSelectElement
    format.value = def.format ?? 'number'
    format.addEventListener('change', () => save({ format: format.value as NumberFormat }))
    const display = dis(h('select', { class: 'base-input', 'data-testid': 'base-setting-display' },
      h('option', { value: 'number' }, 'Chiffres'), h('option', { value: 'bar' }, 'Barre'), h('option', { value: 'ring' }, 'Anneau'))) as HTMLSelectElement
    display.value = def.display ?? 'number'
    display.addEventListener('change', () => save({ display: display.value as PropertyDef['display'] }))
    const max = dis(h('input', { class: 'base-input', type: 'number', 'data-testid': 'base-setting-max', placeholder: '100' })) as HTMLInputElement
    max.value = def.max !== undefined ? String(def.max) : ''
    max.addEventListener('change', () => { const n = Number(max.value); save({ max: Number.isFinite(n) && n > 0 ? n : undefined }) })
    box.append(field('Format', format), field('Affichage', display, max))
  }

  if (type === 'person') {
    const multi = dis(h('input', { type: 'checkbox', 'data-testid': 'base-setting-multiple' })) as HTMLInputElement
    multi.checked = !!def.multiple
    multi.addEventListener('change', () => save({ multiple: multi.checked || undefined }))
    box.append(field('Plusieurs personnes', multi))
  }

  if (type === 'id') {
    const prefix = dis(h('input', { class: 'base-input', 'data-testid': 'base-setting-prefix', placeholder: 'TACHE' })) as HTMLInputElement
    prefix.value = def.prefix ?? ''
    prefix.addEventListener('change', () => save({ prefix: prefix.value.trim().replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 20) || undefined }))
    box.append(field('Préfixe', prefix), h('div', { class: 'base-pop-sub' }, 'Posé à la création de chaque ligne.'))
  }

  if (type === 'relation') {
    const bases = host.bases()
    const target = dis(h('select', { class: 'base-input', 'data-testid': 'base-setting-relation' },
      h('option', { value: '' }, '— choisir une base —'),
      ...bases.map(b => h('option', { value: b.id }, b.id === host.selfBase ? `${b.path} (cette base)` : b.path)))) as HTMLSelectElement
    target.value = def.relation?.base ?? ''
    target.addEventListener('change', () => save({ relation: target.value ? { base: target.value, ...(def.relation?.back ? { back: def.relation.back } : {}) } : undefined }))
    const back = dis(h('input', { class: 'base-input', 'data-testid': 'base-setting-back', placeholder: 'propriété en retour' })) as HTMLInputElement
    back.value = def.relation?.back ?? ''
    back.disabled = !host.editable || !def.relation?.base
    back.addEventListener('change', () => {
      if (!def.relation?.base) return
      const b = back.value.replace(/:/g, '').trim()
      save({ relation: { base: def.relation.base, ...(b ? { back: b } : {}) } })
    })
    box.append(field('Base liée', target), field('Dans les deux sens', back),
      h('div', { class: 'base-pop-sub' }, 'Avec une propriété en retour, chaque ligne liée pointe aussi vers celle-ci.'))
  }
  return box
}

/** Options d'un choix ou d'un statut : valeur, couleur, groupe ; renommer une valeur la change dans les lignes. */
function optionsEditor(host: PropertySettingsHost, def: PropertyDef, save: (patch: Partial<PropertyDef>) => void): HTMLElement {
  const box = h('div', { class: 'base-pop-list', 'data-testid': 'base-setting-options' }, h('div', { class: 'base-pop-sub' }, 'Options'))
  const options: PropertyOption[] = [...(def.options ?? [])]
  const status = def.type === 'status'
  const put = (next: PropertyOption[]) => save({ options: next })
  options.forEach((o, i) => {
    const color = h('select', { class: `base-input base-color-select${colorClass(o.color)}`, title: 'Couleur', 'data-testid': 'base-option-color' },
      ...OPTION_COLORS.map(c => h('option', { value: c.color }, c.label))) as HTMLSelectElement
    color.value = o.color ?? ''
    color.disabled = !host.editable
    color.addEventListener('change', () => put(options.map((x, j) => j === i ? { ...x, color: color.value || undefined } : x)))
    const value = h('input', { class: 'base-input', 'data-testid': 'base-option-value' }) as HTMLInputElement
    value.value = o.value
    value.disabled = !host.editable
    value.addEventListener('change', () => {
      const v = value.value.trim()
      if (!v || v === o.value || options.some(x => x.value === v)) { value.value = o.value; return }
      put(options.map((x, j) => j === i ? { ...x, value: v } : x))
      void host.renameValue(o.value, v).catch(host.report)
    })
    const row = h('div', { class: 'base-pop-row', 'data-testid': 'base-option' }, h('span', { class: `base-pill${colorClass(o.color)}` }, ' '), color, value)
    if (status) {
      const group = h('select', { class: 'base-input', 'data-testid': 'base-option-group' },
        ...STATUS_GROUPS.map(g => h('option', { value: g.group }, g.label))) as HTMLSelectElement
      group.value = o.group ?? 'todo'
      group.disabled = !host.editable
      group.addEventListener('change', () => put(options.map((x, j) => j === i ? { ...x, group: group.value as StatusGroup } : x)))
      row.append(group)
    }
    const move = (d: number) => {
      const j = i + d
      if (j < 0 || j >= options.length) return
      const next = [...options]
      ;[next[i], next[j]] = [next[j], next[i]]
      put(next)
    }
    const up = h('button', { class: 'base-btn', type: 'button', title: 'Monter' }, '↑')
    up.addEventListener('click', () => move(-1))
    const down = h('button', { class: 'base-btn', type: 'button', title: 'Descendre' }, '↓')
    down.addEventListener('click', () => move(1))
    const remove = h('button', { class: 'base-btn', type: 'button', title: 'Retirer l’option (les lignes gardent leur valeur)', 'data-testid': 'base-option-remove' }, '×')
    remove.addEventListener('click', () => put(options.filter((_, j) => j !== i)))
    for (const b of [up, down, remove]) (b as HTMLButtonElement).disabled = !host.editable
    row.append(up, down, remove)
    box.append(row)
  })
  if (host.editable) {
    const input = h('input', { class: 'base-input', placeholder: 'Nouvelle option', 'data-testid': 'base-option-new' }) as HTMLInputElement
    const add = () => {
      const v = input.value.trim()
      if (!v || options.some(o => o.value === v)) return
      put([...options, { value: v, ...(status ? { group: 'todo' as StatusGroup } : {}) }])
    }
    input.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') add() })
    const ok = h('button', { class: 'base-btn', type: 'button', 'data-testid': 'base-option-add' }, '+')
    ok.addEventListener('click', add)
    box.append(h('div', { class: 'base-pop-row' }, input, ok))
    // Valeurs deja vues dans les lignes, pas encore declarees : un clic les ajoute.
    void host.knownValues().then(values => {
      const missing = values.filter(v => !options.some(o => o.value === v)).slice(0, 20)
      if (!missing.length) return
      const all = h('button', { class: 'base-btn', type: 'button', 'data-testid': 'base-option-import' }, `+ ${missing.length} valeur${missing.length > 1 ? 's' : ''} des lignes`)
      all.addEventListener('click', () => put([...options, ...missing.map(v => ({ value: v, ...(status ? { group: 'todo' as StatusGroup } : {}) }))]))
      box.append(all)
    })
  }
  return box
}
