// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Une cellule de base : son affichage et son editeur, selon le type de la
// propriete. Les memes types que le panneau des proprietes de Plume :
// texte, nombre (format, barre, anneau), date (et periode), case, choix,
// choix multiple, statut (couleurs des options), lien, relation, personne
// (une ou plusieurs), adresse web, e-mail, telephone, fichiers, et les
// valeurs posees par l'appli (numero unique, cree / modifie le et par).
import { STATUS_GROUPS, coercePropertyValue, formatNumber, splitDateRange } from '@savoire/plugin-api'
import type { PropertyDef, PropertyMember, PropertyOption, PropertyType, PropertyValue } from '@savoire/plugin-api'
import { colorClass, filterItems, openChoiceMenu, type MenuItem } from './menu'
import { h } from './dom'

export { h } from './dom'

/** Une ligne d'une autre base, proposee dans une relation. */
export interface RelationChoice {
  /** Valeur ecrite : un lien [[...]]. */
  link: string
  title: string
  hint?: string
}

export interface CellContext {
  members: PropertyMember[]
  /** Valeurs proposees pour un choix. */
  knownValues(key: string): Promise<string[]>
  openLink(target: string): void
  /** Definition declaree d'une propriete (options, format, relation...). */
  def?(key: string): PropertyDef | undefined
  /** Une valeur saisie devient une option du type (choix, statut). */
  addOption?(key: string, value: string): void
  /** Relation : les lignes de la base visee qui correspondent a un texte. */
  relationChoices?(key: string, text: string): Promise<RelationChoice[]>
  /** Nom affiche d'une ligne liee (son titre), si on le connait. */
  relationTitle?(key: string, link: string): string | undefined
  /** Envoie un fichier (piece jointe) et rend son lien. */
  upload?(file: File): Promise<string>
}

export function linkTarget(value: string): string {
  const m = /^\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]$/.exec(value.trim())
  return (m ? m[1] : value).trim()
}

/** Nom affiche d'un lien : le nom de la note, sans le dossier. */
export function linkName(value: string): string {
  const alias = /^\[\[[^\]|]+\|([^\]]+)\]\]$/.exec(value.trim())
  if (alias) return alias[1].trim()
  const t = linkTarget(value)
  return t.slice(t.lastIndexOf('/') + 1)
}

/** Texte d'une valeur, pour un filtre ou une infobulle. */
export function valueText(value: PropertyValue | undefined): string {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.join(', ')
  if (typeof value === 'boolean') return value ? 'Oui' : 'Non'
  return String(value)
}

const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.']

/** Une date ISO lisible : « 24 nov. 2026 », « 24 nov. 2026 10:30 ». Texte inconnu : tel quel. */
export function formatDay(iso: string, withYear = true): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(iso)
  if (!m) return iso
  const day = `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]}${withYear ? ` ${m[1]}` : ''}`
  return m[4] ? `${day} ${m[4]}:${m[5]}` : day
}

/** Une date ou une periode « debut/fin ». */
export function formatDate(value: string): string {
  const { start, end } = splitDateRange(value)
  if (!end) return formatDay(start)
  const sameYear = start.slice(0, 4) === end.slice(0, 4)
  return `${formatDay(start, !sameYear)} → ${formatDay(end)}`
}

/** Les options d'une propriete, et leurs couleurs. */
function optionsOf(ctx: CellContext, key: string | undefined): PropertyOption[] {
  return (key && ctx.def?.(key)?.options) || []
}

function pill(value: string, ctx: CellContext, key: string | undefined, type?: PropertyType): HTMLElement {
  const opt = optionsOf(ctx, key).find(o => o.value === value)
  const el = h('span', { class: `base-pill${colorClass(opt?.color)}` }, value)
  if (type === 'status') el.prepend(h('span', { class: `base-status-dot base-status-${opt?.group ?? 'todo'}` }))
  return el
}

function memberName(ctx: CellContext, id: string): string {
  return ctx.members.find(m => m.id === id)?.name ?? id
}

function personChip(ctx: CellContext, id: string): HTMLElement {
  const name = memberName(ctx, id)
  return h('span', { class: 'base-person' }, h('span', { class: 'base-avatar' }, name.slice(0, 1).toUpperCase()), name)
}

function anchor(text: string, href: string, title?: string): HTMLElement {
  const a = h('a', { class: 'base-link', href, target: '_blank', rel: 'noopener noreferrer', title: title ?? href }, text)
  a.addEventListener('click', e => e.stopPropagation())
  return a
}

/** Une valeur de nombre selon son affichage (chiffres, barre, anneau). */
function numberNode(n: number, def: PropertyDef | undefined): Node {
  const text = formatNumber(n, def?.format)
  if (def?.display !== 'bar' && def?.display !== 'ring') return h('span', { class: 'base-num' }, text)
  const max = def.max && def.max > 0 ? def.max : 100
  const ratio = Math.max(0, Math.min(1, n / max))
  if (def.display === 'bar') {
    const fill = h('span', { class: 'base-bar-fill' })
    fill.style.width = `${Math.round(ratio * 100)}%`
    return h('span', { class: 'base-num base-num-bar', title: text }, h('span', { class: 'base-bar' }, fill), h('span', {}, text))
  }
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 20 20')
  svg.setAttribute('class', 'base-ring')
  const track = document.createElementNS(ns, 'circle')
  for (const [k, v] of Object.entries({ cx: '10', cy: '10', r: '8', fill: 'none', 'stroke-width': '3', class: 'base-ring-track' })) track.setAttribute(k, v)
  const arc = document.createElementNS(ns, 'circle')
  const c = 2 * Math.PI * 8
  for (const [k, v] of Object.entries({ cx: '10', cy: '10', r: '8', fill: 'none', 'stroke-width': '3', class: 'base-ring-fill', 'stroke-dasharray': `${(ratio * c).toFixed(2)} ${c.toFixed(2)}`, transform: 'rotate(-90 10 10)' })) arc.setAttribute(k, v)
  svg.append(track, arc)
  return h('span', { class: 'base-num base-num-ring', title: text }, svg as unknown as Node, h('span', {}, text))
}

/** Texte d'une valeur posee par l'appli (numero unique). */
export function idText(value: PropertyValue, def: PropertyDef | undefined): string {
  return def?.prefix ? `${def.prefix}-${valueText(value)}` : valueText(value)
}

/** Affichage d'une valeur (lecture). `key` donne acces aux options et au format de la propriete. */
export function renderValue(type: PropertyType, raw: PropertyValue | undefined, ctx: CellContext, key?: string): Node {
  const value = coercePropertyValue(raw ?? null, type)
  if (value === null || value === '' || (Array.isArray(value) && value.length === 0)) return h('span', { class: 'base-empty' })
  const def = key ? ctx.def?.(key) : undefined
  const list = Array.isArray(value) ? value.map(String) : [String(value)]
  switch (type) {
    case 'checkbox':
      return h('span', { class: 'base-check', 'data-testid': 'base-check' }, value === true ? '☑' : '☐')
    case 'number':
      return typeof value === 'number' ? numberNode(value, def) : h('span', { class: 'base-num' }, String(value))
    case 'select':
    case 'status':
      return pill(valueText(value), ctx, key, type)
    case 'multiselect':
    case 'aliases':
      return h('span', { class: 'base-pills' }, ...list.map(v => pill(v, ctx, key)))
    case 'tags':
      return h('span', { class: 'base-pills' }, ...list.map(v => pill(`#${v.replace(/^#/, '')}`, ctx, key)))
    case 'link':
    case 'relation':
    case 'files': {
      return h('span', { class: type === 'link' ? '' : 'base-pills' }, ...list.map(v => {
        if (/^https?:\/\//i.test(v)) return anchor(type === 'files' ? decodeURIComponent(v.slice(v.lastIndexOf('/') + 1)) || v : v, v)
        const label = type === 'relation' ? (ctx.relationTitle?.(key ?? '', v) ?? linkName(v)) : type === 'files' ? linkName(v) : linkTarget(v)
        const a = h('a', { class: type === 'link' ? 'base-link' : 'base-link base-rel', href: '#', title: linkTarget(v) },
          type === 'files' ? '📎 ' : '', label)
        a.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); ctx.openLink(linkTarget(v)) })
        return a
      }))
    }
    case 'person':
    case 'createdBy':
    case 'modifiedBy':
      return h('span', { class: 'base-pills' }, ...list.map(id => personChip(ctx, id)))
    case 'url':
      return anchor(valueText(value).replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, ''), /^[a-z][a-z0-9+.-]*:/i.test(valueText(value)) ? valueText(value) : `https://${valueText(value)}`)
    case 'email':
      return anchor(valueText(value), `mailto:${valueText(value)}`)
    case 'phone':
      return anchor(valueText(value), `tel:${valueText(value).replace(/[^\d+]/g, '')}`)
    case 'date':
    case 'created':
    case 'modified':
      return h('span', { class: 'base-date', title: valueText(value) }, typeof value === 'string' ? formatDate(value) : valueText(value))
    case 'id':
      return h('span', { class: 'base-id' }, idText(value, def))
    default:
      return h('span', {}, valueText(value))
  }
}

/** Les choix d'un menu : options declarees, puis valeurs vues (sans doublon). */
async function choiceItems(ctx: CellContext, key: string, type: PropertyType, text: string): Promise<MenuItem[]> {
  const options = optionsOf(ctx, key)
  const seen = new Set(options.map(o => o.value))
  const items: MenuItem[] = options.map(o => ({ value: o.value, label: o.value, color: o.color, group: type === 'status' ? (o.group ?? 'todo') : undefined }))
  if (type !== 'status') {
    for (const v of await ctx.knownValues(key)) if (!seen.has(v)) { seen.add(v); items.push({ value: v, label: v }) }
  }
  if (type === 'status') {
    const order = STATUS_GROUPS.map(g => g.group as string)
    items.sort((a, b) => order.indexOf(a.group ?? 'todo') - order.indexOf(b.group ?? 'todo'))
  }
  return filterItems(items, text)
}

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
  const def = ctx.def?.(key)
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

  // ── Menus : choix, statut, choix multiple, personne, relation ──────────
  const menuTypes: PropertyType[] = ['select', 'status', 'multiselect', 'person', 'relation']
  if (menuTypes.includes(type)) {
    const multiple = type === 'multiselect' || type === 'relation' || (type === 'person' && !!def?.multiple)
    const current = Array.isArray(value) ? value.map(String) : value === null ? [] : [String(value)]
    const input = h('input', { class: 'base-editor', 'data-testid': 'base-editor', placeholder: multiple ? 'Ajouter…' : 'Choisir…' })
    if (!multiple) input.value = ''
    const chips = h('span', { class: 'base-editor-chips' })
    const drawChips = (values: string[]) => {
      chips.replaceChildren(...values.map(v => {
        const label = type === 'person' ? memberName(ctx, v) : type === 'relation' ? (ctx.relationTitle?.(key, v) ?? linkName(v)) : v
        return h('span', { class: `base-pill${colorClass(optionsOf(ctx, key).find(o => o.value === v)?.color)}` }, label)
      }))
    }
    if (multiple) drawChips(current)
    host.replaceChildren(h('span', { class: 'base-editor-box' }, chips, input))
    const labels = new Map<string, string>()
    openChoiceMenu({
      anchor: host,
      input,
      multiple,
      selected: current,
      allowCreate: type === 'select' || type === 'multiselect' || type === 'status',
      groups: type === 'status' ? STATUS_GROUPS.map(g => ({ id: g.group, label: g.label })) : undefined,
      items: async text => {
        if (type === 'person') return filterItems(ctx.members.map(m => ({ value: m.id, label: m.name })), text)
        if (type === 'relation') {
          const rows = (await ctx.relationChoices?.(key, text)) ?? []
          for (const r of rows) labels.set(r.link, r.title)
          return rows.map(r => ({ value: r.link, label: r.title, hint: r.hint }))
        }
        return choiceItems(ctx, key, type, text)
      },
      changed: values => drawChips(values),
      done: values => {
        if (values === null) { finish(undefined); return }
        // Une valeur creee devient une option du type.
        if (type !== 'person' && type !== 'relation') {
          const known = new Set(optionsOf(ctx, key).map(o => o.value))
          for (const v of values) if (!known.has(v)) ctx.addOption?.(key, v)
        }
        if (multiple) finish(values)
        else finish(values[0] ?? null)
      },
    })
    input.focus()
    return
  }

  // ── Fichiers : liens ou adresses, un envoi possible ────────────────────
  if (type === 'files') {
    const list = Array.isArray(value) ? value.map(String) : value === null ? [] : [String(value)]
    const items = [...list]
    const box = h('span', { class: 'base-editor-box base-files-editor' })
    const input = h('input', { class: 'base-editor', 'data-testid': 'base-editor', placeholder: '[[fichier]] ou https://…' })
    const draw = () => {
      box.replaceChildren(...items.map((f, i) => {
        const x = h('button', { class: 'base-pill-x', type: 'button', title: 'Retirer' }, '×')
        x.addEventListener('mousedown', e => { e.preventDefault(); items.splice(i, 1); draw() })
        return h('span', { class: 'base-pill' }, linkName(f), x)
      }), input)
      if (ctx.upload) {
        const file = h('input', { type: 'file', class: 'base-file-input', 'data-testid': 'base-file-input' })
        file.addEventListener('change', () => {
          const f = file.files?.[0]
          if (!f) return
          void ctx.upload!(f).then(link => { items.push(link); finish(items) }, () => finish(items))
        })
        const btn = h('button', { class: 'base-pill-x', type: 'button', title: 'Envoyer un fichier' }, '⇪')
        btn.addEventListener('mousedown', e => { e.preventDefault(); file.click() })
        box.append(btn, file)
      }
      input.focus()
    }
    const read = (): PropertyValue => {
      const v = input.value.trim()
      const next = v ? [...items, /^https?:\/\//i.test(v) || v.startsWith('[[') ? v : `[[${v}]]`] : items
      return next
    }
    input.addEventListener('keydown', e => {
      const k = (e as KeyboardEvent).key
      e.stopPropagation()
      if (k === 'Escape') { e.preventDefault(); finish(undefined) }
      if (k === 'Enter') {
        e.preventDefault()
        if (input.value.trim()) { items.splice(0, items.length, ...(read() as string[])); input.value = ''; draw() } else finish(items)
      }
    })
    input.addEventListener('blur', () => setTimeout(() => { if (!host.contains(document.activeElement)) finish(read()) }, 0))
    host.replaceChildren(box)
    draw()
    return
  }

  // ── Date : jour ou jour et heure, fin facultative ──────────────────────
  if (type === 'date') {
    const s = typeof value === 'string' ? value : ''
    const { start, end } = splitDateRange(s)
    const withTime = start.includes('T')
    const box = h('span', { class: 'base-editor-box base-date-editor' })
    const from = h('input', { class: 'base-editor', 'data-testid': 'base-editor', type: withTime ? 'datetime-local' : 'date' })
    from.value = withTime ? start.slice(0, 16) : start.slice(0, 10)
    const to = h('input', { class: 'base-editor', 'data-testid': 'base-editor-end', type: withTime ? 'datetime-local' : 'date' })
    to.value = end ? (withTime ? end.slice(0, 16) : end.slice(0, 10)) : ''
    to.hidden = !end
    const endBtn = h('button', { class: 'base-pill-x', type: 'button', title: 'Date de fin', 'data-testid': 'base-date-end' }, '→')
    endBtn.addEventListener('mousedown', e => { e.preventDefault(); to.hidden = !to.hidden; if (!to.hidden) { to.value ||= from.value; to.focus() } })
    const timeBtn = h('button', { class: 'base-pill-x', type: 'button', title: 'Avec l’heure', 'data-testid': 'base-date-time' }, '🕑')
    timeBtn.addEventListener('mousedown', e => {
      e.preventDefault()
      const t = from.type === 'date' ? 'datetime-local' : 'date'
      for (const i of [from, to]) {
        const v = i.value
        i.type = t
        i.value = t === 'date' ? v.slice(0, 10) : v ? `${v.slice(0, 10)}T09:00` : ''
      }
      from.focus()
    })
    const read = (): PropertyValue => {
      if (!from.value) return null
      return !to.hidden && to.value && to.value !== from.value ? `${from.value}/${to.value}` : from.value
    }
    for (const i of [from, to]) {
      i.addEventListener('keydown', e => {
        const k = (e as KeyboardEvent).key
        e.stopPropagation()
        if (k === 'Enter') { e.preventDefault(); finish(read()) }
        if (k === 'Escape') { e.preventDefault(); finish(undefined) }
      })
      i.addEventListener('blur', () => setTimeout(() => { if (!host.contains(document.activeElement)) finish(read()) }, 0))
    }
    box.append(from, to, endBtn, timeBtn)
    host.replaceChildren(box)
    from.focus()
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
    case 'link':
      input.value = valueText(value)
      input.placeholder = '[[Note]]'
      keys(input, () => {
        const v = input.value.trim()
        return v ? (v.startsWith('[[') ? v : `[[${v}]]`) : null
      })
      break
    case 'url':
    case 'email':
    case 'phone':
      input.type = type === 'url' ? 'url' : type === 'email' ? 'email' : 'tel'
      input.value = valueText(value)
      input.placeholder = type === 'url' ? 'https://…' : type === 'email' ? 'nom@exemple.fr' : '+33 …'
      keys(input, () => input.value.trim() || null)
      break
    default:
      input.value = valueText(value)
      keys(input, () => input.value === '' ? null : input.value)
  }
  host.replaceChildren(input)
  input.focus()
  input.select?.()
}
