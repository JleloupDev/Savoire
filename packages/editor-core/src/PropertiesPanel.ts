// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Panneau des proprietes d'une note (facon Obsidian « Properties »), en tete
// de la note, a la place du bloc YAML brut. Une ligne par propriete : icone
// du type, nom, editeur adapte au type. On ajoute, supprime, renomme une
// propriete, on change son type (pour tout le vault). Un bouton rend le YAML
// source, un autre ramene le panneau.
//
// Le panneau n'a pas d'etat propre : il lit le frontmatter du texte, et
// chaque modification est un remplacement minimal du texte (frontmatterEdit),
// envoye a CodeMirror comme une frappe : meme CRDT, memes pairs.
import { EditorView, WidgetType, Decoration } from '@codemirror/view'
import { Facet, StateEffect, StateField } from '@codemirror/state'
import type { EditorState, Range } from '@codemirror/state'
import {
  PROPERTY_TYPES, PROPERTY_TYPE_INFO, coercePropertyValue, findFrontmatter, frontmatterKeys,
  minimalTextChange, parseFrontmatter, propertyTypeOf, removeFrontmatterKey,
  renameFrontmatterKey, setFrontmatterValue,
} from '@savoire/plugin-api'
import type { IPropertyTypes, PropertyMember, PropertyType, PropertyValue } from '@savoire/plugin-api'

/** Ce que le panneau demande a son editeur. */
export interface PropertiesHost {
  readOnly: boolean
  /** Types des proprietes du vault (absents : types devines, non modifiables). */
  types(): IPropertyTypes | undefined
  /** Valeurs deja vues dans le vault pour une propriete (choix proposes). */
  knownValues?(key: string): Promise<string[]>
  /** Membres du vault (type personne). */
  members?(): Promise<PropertyMember[]>
  /** Ouvre la note visee par un lien `[[...]]`. */
  openLink?(target: string): void
}

export const propertiesHost = Facet.define<PropertiesHost, PropertiesHost | null>({
  combine: values => values[0] ?? null,
})

/** Montre le YAML source (true) ou le panneau (false). */
export const showYamlSource = StateEffect.define<boolean>()
/** Ouvre la ligne « nouvelle propriete », meme sans frontmatter. */
export const startAddProperty = StateEffect.define<boolean>()
/** Les types du vault ont change : redessiner. */
export const propertiesRefresh = StateEffect.define<null>()

const yamlSourceField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(showYamlSource)) return e.value
    return value
  },
})

const addingField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(startAddProperty)) return e.value
    return value
  },
})

let refreshCounter = 0
const refreshField = StateField.define<number>({
  create: () => 0,
  update(value, tr) {
    return tr.effects.some(e => e.is(propertiesRefresh)) ? ++refreshCounter : value
  },
})

/** Vrai si la transaction demande de redessiner la zone des proprietes. */
export function isPropertiesEffect(e: StateEffect<unknown>): boolean {
  return e.is(showYamlSource) || e.is(startAddProperty) || e.is(propertiesRefresh)
}

/** Fin du bloc de frontmatter (0 sans bloc). */
export function frontmatterEnd(state: EditorState): number {
  return findFrontmatter(state.doc.toString())?.end ?? 0
}

/**
 * Decorations de la zone des proprietes, ou null si l'editeur n'a pas de
 * panneau (LivePreview garde alors son badge « ··· »).
 */
export function propertiesDecorations(state: EditorState, fmEnd: number): Range<Decoration>[] | null {
  const host = state.facet(propertiesHost)
  if (!host) return null
  const source = state.field(yamlSourceField, false) ?? false
  const adding = state.field(addingField, false) ?? false
  const refresh = state.field(refreshField, false) ?? 0
  if (source) {
    // YAML brut, avec un bouton pour revenir au panneau.
    return fmEnd > 0 ? [Decoration.widget({ widget: new BackToPanelWidget(), block: true, side: -1 }).range(0)] : []
  }
  const text = state.doc.sliceString(0, fmEnd)
  const widget = new PropertiesWidget(host, text, adding, refresh)
  if (fmEnd > 0) return [Decoration.replace({ widget, block: true }).range(0, fmEnd)]
  if (adding) return [Decoration.widget({ widget, block: true, side: -1 }).range(0)]
  return []
}

class BackToPanelWidget extends WidgetType {
  eq(): boolean { return true }
  toDOM(view: EditorView): HTMLElement {
    const bar = document.createElement('div')
    bar.className = 'plume-props-sourcebar'
    bar.contentEditable = 'false'
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.dataset.testid = 'properties-panel-back'
    btn.textContent = '☰ Afficher le panneau des propriétés'
    btn.addEventListener('mousedown', e => {
      e.preventDefault()
      view.dispatch({ effects: showYamlSource.of(false) })
    })
    bar.appendChild(btn)
    return bar
  }
  ignoreEvent(): boolean { return true }
}

class PropertiesWidget extends WidgetType {
  constructor(
    private readonly host: PropertiesHost,
    readonly text: string,
    readonly adding: boolean,
    readonly refresh: number,
  ) { super() }

  eq(other: PropertiesWidget): boolean {
    return other.text === this.text && other.adding === this.adding && other.refresh === this.refresh
  }

  toDOM(view: EditorView): HTMLElement {
    const panel = new PropertiesPanel(view, this.host)
    panel.render(this.text, this.adding)
    return panel.root
  }

  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    const panel = panels.get(dom)
    if (!panel) return false
    panel.view = view
    panel.render(this.text, this.adding)
    return true
  }

  ignoreEvent(): boolean { return true }
}

const panels = new WeakMap<HTMLElement, PropertiesPanel>()
let listCounter = 0

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

function emptyValue(type: PropertyType): PropertyValue {
  if (type === 'checkbox') return false
  if (type === 'multiselect') return []
  return null
}

function linkTarget(value: string): string {
  const m = /^\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]$/.exec(value.trim())
  return (m ? m[1] : value).trim()
}

/** Le panneau, reconstruit a chaque changement du frontmatter (sauf la ligne en cours d'edition). */
export class PropertiesPanel {
  readonly root: HTMLElement
  private readonly rows: HTMLElement
  private menu: HTMLElement | null = null

  constructor(public view: EditorView, private readonly host: PropertiesHost) {
    this.root = el('div', 'plume-props')
    this.root.dataset.testid = 'properties-panel'
    this.root.contentEditable = 'false'
    const head = el('div', 'plume-props-head')
    head.appendChild(el('span', 'plume-props-title', 'Propriétés'))
    const yaml = el('button', 'plume-props-yaml', 'YAML')
    yaml.type = 'button'
    yaml.title = 'Voir le YAML source'
    yaml.dataset.testid = 'properties-yaml'
    yaml.addEventListener('click', () => this.view.dispatch({ effects: showYamlSource.of(true) }))
    head.appendChild(yaml)
    this.rows = el('div', 'plume-props-rows')
    this.root.append(head, this.rows)
    panels.set(this.root, this)
  }

  // ── Ecriture ─────────────────────────────────────────────────────────────

  /** Applique une edition du texte de la note, en remplacement minimal. */
  private edit(fn: (markdown: string) => string, effects: StateEffect<unknown>[] = []): void {
    if (this.host.readOnly) return
    const before = this.view.state.doc.toString()
    const change = minimalTextChange(before, fn(before))
    if (change) this.view.dispatch({ changes: change, effects, userEvent: 'input.properties' })
    else if (effects.length) this.view.dispatch({ effects })
  }

  private setValue(key: string, value: PropertyValue): void {
    this.edit(md => setFrontmatterValue(md, key, value))
  }

  // ── Rendu ────────────────────────────────────────────────────────────────

  render(text: string, adding: boolean): void {
    this.closeMenu()
    const values = parseFrontmatter(text)
    const keys = frontmatterKeys(text)
    // La ligne qui a le focus n'est pas reconstruite : on ne coupe pas une saisie.
    const active = document.activeElement
    const keep = new Map<string, HTMLElement>()
    for (const row of Array.from(this.rows.children) as HTMLElement[]) {
      if (active && row.contains(active) && row.dataset.key !== undefined) keep.set(row.dataset.key, row)
    }
    const next: HTMLElement[] = keys.map(key => keep.get(key) ?? this.renderRow(key, values[key] ?? null))
    // La ligne « nouvelle propriete » n'est gardee que tant qu'on la remplit.
    if (!this.host.readOnly) next.push((adding && keep.get('')) || this.renderAdd(adding, keys))
    this.rows.replaceChildren(...next)
    this.root.classList.toggle('plume-props-readonly', this.host.readOnly)
  }

  private renderRow(key: string, raw: PropertyValue): HTMLElement {
    const types = this.host.types()
    const type = propertyTypeOf(types, key, raw)
    const value = coercePropertyValue(raw, type)
    const row = el('div', 'plume-prop')
    row.dataset.key = key
    row.dataset.type = type
    row.dataset.testid = 'property-row'

    const icon = el('button', 'plume-prop-icon', PROPERTY_TYPE_INFO[type].icon)
    icon.type = 'button'
    icon.title = `${PROPERTY_TYPE_INFO[type].label}${types?.get(key) ? '' : ' (deviné)'} : changer le type`
    icon.dataset.testid = 'property-type'
    icon.disabled = this.host.readOnly || !types
    icon.addEventListener('click', () => this.openTypeMenu(icon, key, type))

    const name = el('input', 'plume-prop-name')
    name.value = key
    name.dataset.testid = 'property-name'
    name.disabled = this.host.readOnly
    name.setAttribute('aria-label', 'Nom de la propriété')
    name.addEventListener('change', () => {
      const to = name.value.replace(/:/g, '').trim()
      if (!to || to === key) { name.value = key; return }
      this.edit(md => renameFrontmatterKey(md, key, to))
    })
    name.addEventListener('keydown', e => { if (e.key === 'Enter') name.blur() })

    const cell = el('div', 'plume-prop-value')
    cell.dataset.testid = 'property-value'
    this.renderEditor(cell, key, type, value, raw)

    const remove = el('button', 'plume-prop-remove', '×')
    remove.type = 'button'
    remove.title = 'Supprimer la propriété'
    remove.dataset.testid = 'property-remove'
    remove.hidden = this.host.readOnly
    remove.addEventListener('click', () => this.edit(md => removeFrontmatterKey(md, key)))

    row.append(icon, name, cell, remove)
    return row
  }

  private renderEditor(cell: HTMLElement, key: string, type: PropertyType, value: PropertyValue, raw: PropertyValue): void {
    const ro = this.host.readOnly
    const mismatch = (ok: boolean) => { if (!ok && raw !== null) { cell.classList.add('plume-prop-mismatch'); cell.title = 'Valeur différente du type de la propriété' } }
    const textInput = (inputType: string, current: string, commit: (v: string) => void) => {
      const input = el('input', 'plume-prop-input')
      input.type = inputType
      input.value = current
      input.disabled = ro
      input.addEventListener('change', () => commit(input.value))
      input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur() })
      cell.appendChild(input)
      return input
    }
    switch (type) {
      case 'checkbox': {
        mismatch(typeof value === 'boolean')
        const box = el('input', 'plume-prop-check')
        box.type = 'checkbox'
        box.checked = value === true
        box.disabled = ro
        box.addEventListener('change', () => this.setValue(key, box.checked))
        cell.appendChild(box)
        return
      }
      case 'number': {
        const ok = typeof value === 'number'
        mismatch(ok)
        textInput(ok || value === null ? 'number' : 'text', value === null ? '' : String(value), v => {
          const n = Number(v)
          this.setValue(key, v.trim() === '' ? null : Number.isFinite(n) ? n : v)
        })
        return
      }
      case 'date': {
        const s = typeof value === 'string' ? value : ''
        const ok = /^\d{4}-\d{2}-\d{2}/.test(s)
        mismatch(ok)
        const withTime = s.includes('T')
        textInput(ok || value === null ? (withTime ? 'datetime-local' : 'date') : 'text', withTime ? s.slice(0, 16) : s, v => this.setValue(key, v || null))
        return
      }
      case 'select': {
        mismatch(!Array.isArray(value))
        const input = textInput('text', value === null ? '' : String(value), v => this.setValue(key, v.trim() || null))
        input.classList.add('plume-prop-pill-input')
        this.suggest(input, key)
        return
      }
      case 'multiselect': {
        const list = Array.isArray(value) ? value : value === null ? [] : [String(value)]
        const pills = el('div', 'plume-prop-pills')
        for (const item of list) {
          const pill = el('span', 'plume-pill', item)
          pill.dataset.testid = 'property-pill'
          if (!ro) {
            const x = el('button', 'plume-pill-x', '×')
            x.type = 'button'
            x.title = `Retirer « ${item} »`
            x.addEventListener('click', () => this.setValue(key, list.filter(v => v !== item)))
            pill.appendChild(x)
          }
          pills.appendChild(pill)
        }
        cell.appendChild(pills)
        if (!ro) {
          const input = el('input', 'plume-prop-input plume-prop-add-pill')
          input.placeholder = 'Ajouter…'
          input.dataset.testid = 'property-pill-input'
          const add = () => {
            const v = input.value.trim()
            if (!v || list.includes(v)) { input.value = ''; return }
            this.setValue(key, [...list, v])
          }
          input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add() } })
          input.addEventListener('change', add)
          cell.appendChild(input)
          this.suggest(input, key)
        }
        return
      }
      case 'link': {
        const s = value === null ? '' : Array.isArray(value) ? value.join(', ') : String(value)
        if (s && !ro) {
          const a = el('a', 'plume-prop-link', linkTarget(s))
          a.href = '#'
          a.dataset.testid = 'property-link'
          a.addEventListener('click', e => { e.preventDefault(); this.host.openLink?.(linkTarget(s)) })
          const edit = el('button', 'plume-prop-edit', '✎')
          edit.type = 'button'
          edit.title = 'Modifier le lien'
          edit.addEventListener('click', () => {
            cell.replaceChildren()
            const input = this.linkInput(cell, key, s)
            input.focus()
          })
          cell.append(a, edit)
          return
        }
        if (s) {
          const a = el('a', 'plume-prop-link', linkTarget(s))
          a.href = '#'
          a.addEventListener('click', e => { e.preventDefault(); this.host.openLink?.(linkTarget(s)) })
          cell.appendChild(a)
          return
        }
        this.linkInput(cell, key, s)
        return
      }
      case 'person': {
        const id = value === null ? '' : String(value)
        const select = el('select', 'plume-prop-input')
        select.disabled = ro
        select.dataset.testid = 'property-person'
        const blank = el('option', undefined, '—')
        blank.value = ''
        select.appendChild(blank)
        if (id) {
          const cur = el('option', undefined, id)
          cur.value = id
          select.appendChild(cur)
          select.value = id
        }
        void this.host.members?.().then(members => {
          for (const m of members) {
            const existing = Array.from(select.options).find(o => o.value === m.id)
            if (existing) { existing.textContent = m.name; continue }
            const opt = el('option', undefined, m.name)
            opt.value = m.id
            select.appendChild(opt)
          }
          select.value = id
        })
        select.addEventListener('change', () => this.setValue(key, select.value || null))
        cell.appendChild(select)
        return
      }
      case 'text':
      default:
        mismatch(!Array.isArray(value))
        textInput('text', value === null ? '' : Array.isArray(value) ? value.join(', ') : String(value), v => this.setValue(key, v === '' ? null : v))
    }
  }

  private linkInput(cell: HTMLElement, key: string, current: string): HTMLInputElement {
    const input = el('input', 'plume-prop-input')
    input.value = current
    input.placeholder = '[[Note]]'
    input.disabled = this.host.readOnly
    input.addEventListener('change', () => {
      const v = input.value.trim()
      this.setValue(key, v ? (v.startsWith('[[') ? v : `[[${v}]]`) : null)
    })
    input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur() })
    cell.appendChild(input)
    return input
  }

  /** Propose les valeurs deja vues (et les options du type) dans une liste. */
  private suggest(input: HTMLInputElement, key: string): void {
    const list = el('datalist')
    list.id = `plume-prop-values-${++listCounter}`
    input.setAttribute('list', list.id)
    input.after(list)
    input.addEventListener('focus', () => {
      const options = (this.host.types()?.get(key)?.options ?? []).map(o => o.value)
      const fill = (values: string[]) => {
        list.replaceChildren(...[...new Set([...options, ...values])].map(v => { const o = el('option'); o.value = v; return o }))
      }
      fill([])
      void this.host.knownValues?.(key).then(fill).catch(() => {})
    }, { once: true })
  }

  private renderAdd(adding: boolean, keys: string[]): HTMLElement {
    const row = el('div', 'plume-prop plume-prop-new')
    row.dataset.key = ''
    if (!adding) {
      const add = el('button', 'plume-props-add', '+ Ajouter une propriété')
      add.type = 'button'
      add.dataset.testid = 'property-add'
      add.addEventListener('click', () => this.view.dispatch({ effects: startAddProperty.of(true) }))
      row.appendChild(add)
      return row
    }
    const types = this.host.types()
    const type = el('select', 'plume-prop-newtype')
    type.dataset.testid = 'property-new-type'
    for (const t of PROPERTY_TYPES) {
      const o = el('option', undefined, `${PROPERTY_TYPE_INFO[t].icon} ${PROPERTY_TYPE_INFO[t].label}`)
      o.value = t
      type.appendChild(o)
    }
    const name = el('input', 'plume-prop-name')
    name.placeholder = 'Nom de la propriété'
    name.dataset.testid = 'property-new-name'
    const confirm = () => {
      const key = name.value.replace(/:/g, '').trim()
      if (!key) return
      if (keys.includes(key)) { name.setCustomValidity('Cette propriété existe déjà'); name.reportValidity(); return }
      const chosen = type.value as PropertyType
      const declared = types?.get(key)?.type
      // Le type choisi vaut pour tout le vault, sauf si la propriete en a deja un.
      if (types && !declared && chosen !== 'text') {
        try { types.set({ key, type: chosen }) } catch { /* sans vault : type devine */ }
      }
      this.edit(md => setFrontmatterValue(md, key, emptyValue(declared ?? chosen)), [startAddProperty.of(false)])
    }
    name.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); confirm() }
      if (e.key === 'Escape') { e.preventDefault(); this.view.dispatch({ effects: startAddProperty.of(false) }) }
    })
    name.addEventListener('input', () => name.setCustomValidity(''))
    const ok = el('button', 'plume-props-add', 'Ajouter')
    ok.type = 'button'
    ok.dataset.testid = 'property-new-confirm'
    ok.addEventListener('click', confirm)
    row.append(type, name, ok)
    queueMicrotask(() => { if (row.isConnected) name.focus() })
    return row
  }

  // ── Menu des types ───────────────────────────────────────────────────────

  private openTypeMenu(anchor: HTMLElement, key: string, current: PropertyType): void {
    const types = this.host.types()
    if (!types || this.host.readOnly) return
    if (this.menu) { this.closeMenu(); return }
    const menu = el('div', 'plume-props-menu')
    menu.dataset.testid = 'property-type-menu'
    for (const t of PROPERTY_TYPES) {
      const item = el('button', 'plume-props-menu-item', `${PROPERTY_TYPE_INFO[t].icon}  ${PROPERTY_TYPE_INFO[t].label}`)
      item.type = 'button'
      item.dataset.type = t
      if (t === current) item.classList.add('plume-props-menu-current')
      item.addEventListener('click', () => {
        this.closeMenu()
        const def = types.get(key)
        // Le type change pour tout le vault ; les valeurs des notes restent telles quelles.
        types.set({ ...(def ?? { key }), key, type: t })
        this.view.dispatch({ effects: propertiesRefresh.of(null) })
      })
      menu.appendChild(item)
    }
    const row = anchor.closest('.plume-prop') as HTMLElement | null
    ;(row ?? this.root).appendChild(menu)
    this.menu = menu
    const close = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node) && e.target !== anchor) { this.closeMenu(); document.removeEventListener('mousedown', close, true) }
    }
    document.addEventListener('mousedown', close, true)
  }

  private closeMenu(): void {
    this.menu?.remove()
    this.menu = null
  }
}

/** Montre la ligne « nouvelle propriete » (commande « Ajouter une propriété »). */
export function addProperty(view: EditorView): void {
  view.dispatch({ effects: [showYamlSource.of(false), startAddProperty.of(true)] })
}

/** Bascule entre le panneau et le YAML source. */
export function toggleYamlSource(view: EditorView): void {
  view.dispatch({ effects: showYamlSource.of(!(view.state.field(yamlSourceField, false) ?? false)) })
}

/**
 * Le curseur ne reste pas devant le panneau : une frappe y casserait le
 * frontmatter (elle passerait avant le premier `---`). A l'ouverture d'une
 * note, le curseur est en 0 ; il passe juste apres le bloc.
 */
const keepCursorAfterPanel = EditorView.updateListener.of(update => {
  if (!update.docChanged && !update.selectionSet) return
  const state = update.state
  if (state.field(yamlSourceField, false)) return
  const end = frontmatterEnd(state)
  if (end === 0 || state.selection.main.head >= end) return
  queueMicrotask(() => {
    const view = update.view
    const now = frontmatterEnd(view.state)
    if (now > 0 && view.state.selection.main.head < now && !view.state.field(yamlSourceField, false)) {
      view.dispatch({ selection: { anchor: Math.min(now, view.state.doc.length) } })
    }
  })
})

/** L'extension : a ajouter a l'editeur pour remplacer le YAML par le panneau. */
export function propertiesPanelExtension(host: PropertiesHost) {
  return [
    propertiesHost.of(host),
    yamlSourceField,
    addingField,
    refreshField,
    keepCursorAfterPanel,
    EditorView.baseTheme({
      '.plume-props': {
        margin: '4px 0 10px', padding: '6px 4px 6px 0', borderBottom: '1px solid var(--border, #313244)',
        fontFamily: 'var(--font-ui, sans-serif)', fontSize: '13px', whiteSpace: 'normal', cursor: 'default',
        position: 'relative',
      },
      '.plume-props-head': { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px', color: 'var(--text-muted, #a6adc8)' },
      '.plume-props-title': { fontWeight: '600', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.04em' },
      '.plume-props-yaml, .plume-props-sourcebar button': {
        marginLeft: 'auto', fontSize: '11px', padding: '1px 6px', borderRadius: '4px',
        border: '1px solid var(--border, #313244)', background: 'transparent', color: 'var(--text-muted, #a6adc8)', cursor: 'pointer',
      },
      '.plume-props-sourcebar': { display: 'flex', padding: '2px 0', fontFamily: 'var(--font-ui, sans-serif)' },
      '.plume-prop': { display: 'flex', alignItems: 'center', gap: '6px', minHeight: '28px', position: 'relative' },
      '.plume-prop-icon': {
        width: '24px', height: '24px', border: 'none', background: 'transparent', cursor: 'pointer',
        color: 'var(--text-muted, #a6adc8)', borderRadius: '4px', flex: '0 0 auto',
      },
      '.plume-prop-icon:hover:not(:disabled)': { background: 'var(--bg-hover, rgba(255,255,255,0.06))' },
      '.plume-prop-name': {
        width: '140px', flex: '0 0 auto', border: '1px solid transparent', background: 'transparent',
        color: 'var(--text-muted, #a6adc8)', padding: '2px 4px', borderRadius: '4px', font: 'inherit',
      },
      '.plume-prop-name:hover, .plume-prop-name:focus, .plume-prop-input:hover, .plume-prop-input:focus': {
        borderColor: 'var(--border, #313244)', outline: 'none',
      },
      '.plume-prop-value': { flex: '1 1 auto', display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap', minWidth: '0' },
      '.plume-prop-input': {
        flex: '1 1 auto', minWidth: '80px', border: '1px solid transparent', background: 'transparent',
        color: 'var(--text, #cdd6f4)', padding: '2px 4px', borderRadius: '4px', font: 'inherit',
      },
      '.plume-prop-pill-input': { background: 'var(--bg-surface, #252535)' },
      '.plume-prop-pills': { display: 'flex', gap: '4px', flexWrap: 'wrap' },
      '.plume-pill': {
        display: 'inline-flex', alignItems: 'center', gap: '2px', padding: '0 6px', borderRadius: '10px',
        background: 'color-mix(in srgb, var(--accent, #7c3aed) 22%, transparent)', color: 'var(--text, #cdd6f4)', fontSize: '12px',
      },
      '.plume-pill-x': { border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', padding: '0 0 0 2px', opacity: '0.7' },
      '.plume-prop-link': { color: 'var(--accent, #7c3aed)', textDecoration: 'underline', cursor: 'pointer' },
      '.plume-prop-edit': { border: 'none', background: 'transparent', color: 'var(--text-faint, #6c7086)', cursor: 'pointer' },
      '.plume-prop-remove': {
        border: 'none', background: 'transparent', color: 'var(--text-faint, #6c7086)', cursor: 'pointer',
        visibility: 'hidden', fontSize: '15px',
      },
      '.plume-prop:hover .plume-prop-remove': { visibility: 'visible' },
      '.plume-prop-mismatch .plume-prop-input': { textDecoration: 'underline wavy var(--color-warn, #d19a2f)' },
      '.plume-props-add': {
        border: 'none', background: 'transparent', color: 'var(--text-faint, #6c7086)', cursor: 'pointer',
        padding: '2px 4px', font: 'inherit',
      },
      '.plume-prop-newtype': {
        background: 'var(--bg-surface, #252535)', color: 'var(--text, #cdd6f4)', border: '1px solid var(--border, #313244)',
        borderRadius: '4px', font: 'inherit', padding: '1px 2px',
      },
      '.plume-props-menu': {
        position: 'absolute', top: '28px', left: '0', zIndex: '20', display: 'flex', flexDirection: 'column',
        background: 'var(--bg-surface, #252535)', border: '1px solid var(--border, #313244)', borderRadius: '6px',
        padding: '4px', boxShadow: '0 6px 18px rgba(0,0,0,0.35)', minWidth: '170px',
      },
      '.plume-props-menu-item': {
        textAlign: 'left', border: 'none', background: 'transparent', color: 'var(--text, #cdd6f4)',
        padding: '4px 8px', borderRadius: '4px', cursor: 'pointer', font: 'inherit',
      },
      '.plume-props-menu-item:hover, .plume-props-menu-current': { background: 'var(--bg-hover, rgba(255,255,255,0.08))' },
    }),
  ]
}
