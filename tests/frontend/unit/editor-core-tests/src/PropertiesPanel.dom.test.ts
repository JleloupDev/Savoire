// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Panneau des proprietes de Plume : il remplace le YAML brut, chaque type a
// son editeur, et chaque modification est un remplacement minimal du texte.
import { describe, it, expect, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { createLivePreviewExtension } from '../../../../../packages/editor-core/src/LivePreview'
import { propertiesPanelExtension, addProperty, toggleYamlSource } from '../../../../../packages/editor-core/src/PropertiesPanel'
import type { PropertiesHost } from '../../../../../packages/editor-core/src/PropertiesPanel'
import { parseFrontmatter } from '@savoire/plugin-api'
import type { IPropertyTypes, PropertyDef } from '@savoire/plugin-api'

const NOTE = [
  '---',
  'status: En cours',
  'priority: 2',
  'due: 2026-11-03',
  'done: false',
  'tags:',
  '  - urgent',
  '  - client',
  'parent: "[[Projet Alpha]]"',
  'owner: u1',
  'note: libre',
  '---',
  '# Titre',
  'Corps',
].join('\n')

function fakeTypes(initial: PropertyDef[] = []): IPropertyTypes & { listeners: Set<() => void> } {
  const defs = new Map(initial.map(d => [d.key, d]))
  const listeners = new Set<() => void>()
  return {
    listeners,
    schema: () => ({ properties: [...defs.values()] }),
    get: key => defs.get(key),
    set: vi.fn((def: PropertyDef) => { defs.set(def.key, def); for (const cb of listeners) cb() }),
    remove: key => { defs.delete(key) },
    onChange: cb => { listeners.add(cb); return () => listeners.delete(cb) },
    members: async () => [{ id: 'u1', name: 'Alice' }, { id: 'u2', name: 'Bob' }],
  }
}

function mount(doc: string, types = fakeTypes([
  { key: 'status', type: 'select', options: [{ value: 'Terminé' }] },
  { key: 'owner', type: 'person' },
  { key: 'parent', type: 'link' },
]), extra: Partial<PropertiesHost> = {}) {
  const host: PropertiesHost = {
    readOnly: false,
    types: () => types,
    knownValues: async () => ['En cours', 'À faire'],
    members: () => types.members!(),
    openLink: vi.fn(),
    ...extra,
  }
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [markdown({ base: markdownLanguage }), ...propertiesPanelExtension(host), ...createLivePreviewExtension()],
    }),
  })
  const panel = () => view.dom.querySelector('[data-testid="properties-panel"]') as HTMLElement | null
  const row = (key: string) => panel()!.querySelector(`[data-key="${key}"]`) as HTMLElement
  const change = (input: HTMLInputElement | HTMLSelectElement, value: string) => {
    input.value = value
    input.dispatchEvent(new Event('change'))
  }
  return { view, host, types, panel, row, change, text: () => view.state.doc.toString() }
}

describe('panneau des proprietes', () => {
  it('remplace le YAML brut ; une ligne par propriete, avec le type declare ou devine', () => {
    const { panel, row, view } = mount(NOTE)
    expect(panel()).not.toBeNull()
    expect(view.contentDOM.textContent).not.toContain('status: En cours')
    const types = Object.fromEntries(Array.from(panel()!.querySelectorAll('[data-testid="property-row"]')).map(r => [(r as HTMLElement).dataset.key, (r as HTMLElement).dataset.type]))
    expect(types).toEqual({
      status: 'select', priority: 'number', due: 'date', done: 'checkbox',
      tags: 'multiselect', parent: 'link', owner: 'person', note: 'text',
    })
    expect((row('due').querySelector('[data-testid=\"property-value\"] input') as HTMLInputElement).type).toBe('date')
    expect((row('priority').querySelector('[data-testid=\"property-value\"] input') as HTMLInputElement).type).toBe('number')
    expect(Array.from(row('tags').querySelectorAll('[data-testid="property-pill"]')).map(p => p.firstChild!.textContent)).toEqual(['urgent', 'client'])
    expect(row('parent').querySelector('[data-testid="property-link"]')!.textContent).toBe('Projet Alpha')
  })

  it('chaque editeur ecrit le frontmatter, en ne touchant que sa valeur', () => {
    const { row, change, text, view } = mount(NOTE)
    change(row('priority').querySelector('[data-testid=\"property-value\"] input')!, '5')
    expect(text()).toBe(NOTE.replace('priority: 2', 'priority: 5'))
    const box = row('done').querySelector('[data-testid=\"property-value\"] input') as HTMLInputElement
    box.checked = true
    box.dispatchEvent(new Event('change'))
    change(row('due').querySelector('[data-testid=\"property-value\"] input')!, '2026-12-24')
    change(row('status').querySelector('[data-testid=\"property-value\"] input')!, 'Terminé')
    change(row('note').querySelector('[data-testid=\"property-value\"] input')!, 'avec: deux-points')
    const fm = parseFrontmatter(text())
    expect(fm).toMatchObject({ priority: 5, done: true, due: '2026-12-24', status: 'Terminé', note: 'avec: deux-points' })
    expect(text().endsWith('---\n# Titre\nCorps')).toBe(true)
    expect(view.state.doc.lines).toBe(NOTE.split('\n').length)
  })

  it('choix multiple : ajouter et retirer des pastilles', () => {
    const { row, text } = mount(NOTE)
    const input = row('tags').querySelector('[data-testid="property-pill-input"]') as HTMLInputElement
    input.value = 'interne'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(parseFrontmatter(text()).tags).toEqual(['urgent', 'client', 'interne'])
    ;(row('tags').querySelector('.plume-pill-x') as HTMLButtonElement).click()
    expect(parseFrontmatter(text()).tags).toEqual(['client', 'interne'])
    expect(text()).toContain('tags:\n  - client\n  - interne\n')
  })

  it('lien cliquable ; personne choisie parmi les membres', async () => {
    const { row, host, change, text } = mount(NOTE)
    ;(row('parent').querySelector('[data-testid="property-link"]') as HTMLElement).click()
    expect(host.openLink).toHaveBeenCalledWith('Projet Alpha')
    await new Promise(r => setTimeout(r, 0))
    const select = row('owner').querySelector('[data-testid=\"property-value\"] select') as HTMLSelectElement
    expect(Array.from(select.options).map(o => o.textContent)).toEqual(['—', 'Alice', 'Bob'])
    change(select, 'u2')
    expect(parseFrontmatter(text()).owner).toBe('u2')
  })

  it('renommer, supprimer, ajouter une propriete', () => {
    const { row, change, text, panel } = mount(NOTE)
    change(row('note').querySelector('[data-testid="property-name"]') as HTMLInputElement, 'remarque')
    expect(parseFrontmatter(text())).toHaveProperty('remarque', 'libre')
    ;(row('remarque').querySelector('[data-testid="property-remove"]') as HTMLButtonElement).click()
    expect(parseFrontmatter(text())).not.toHaveProperty('remarque')
    ;(panel()!.querySelector('[data-testid="property-add"]') as HTMLButtonElement).click()
    const name = panel()!.querySelector('[data-testid="property-new-name"]') as HTMLInputElement
    const type = panel()!.querySelector('[data-testid="property-new-type"]') as HTMLSelectElement
    type.value = 'checkbox'
    name.value = 'publié'
    name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(parseFrontmatter(text())).toHaveProperty('publié', false)
    expect(row('publié').dataset.type).toBe('checkbox')
  })

  it('changer le type vaut pour tout le vault, sans reecrire la note', () => {
    const { row, types, text } = mount(NOTE)
    ;(row('note').querySelector('[data-testid="property-type"]') as HTMLButtonElement).click()
    const item = row('note').querySelector('[data-testid="property-type-menu"] [data-type="multiselect"]') as HTMLButtonElement
    item.click()
    expect(types.set).toHaveBeenCalledWith({ key: 'note', type: 'multiselect' })
    expect(text()).toBe(NOTE)
    expect(row('note').dataset.type).toBe('multiselect')
  })

  it('une note sans frontmatter : rien, puis la commande Ajouter une propriete cree le bloc', () => {
    const { view, panel, text } = mount('# Seule\n')
    expect(panel()).toBeNull()
    addProperty(view)
    const name = panel()!.querySelector('[data-testid="property-new-name"]') as HTMLInputElement
    name.value = 'statut'
    name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(text()).toBe('---\nstatut:\n---\n# Seule\n')
  })

  it('YAML source et retour au panneau', () => {
    const { view, panel } = mount(NOTE)
    ;(panel()!.querySelector('[data-testid="properties-yaml"]') as HTMLButtonElement).click()
    expect(panel()).toBeNull()
    expect(view.contentDOM.textContent).toContain('status: En cours')
    toggleYamlSource(view)
    expect(panel()).not.toBeNull()
  })

  it('lecture seule : editeurs desactives, aucun bouton d ajout', () => {
    const { panel, row } = mount(NOTE, undefined, { readOnly: true })
    expect((row('priority').querySelector('[data-testid=\"property-value\"] input') as HTMLInputElement).disabled).toBe(true)
    expect(panel()!.querySelector('[data-testid="property-add"]')).toBeNull()
  })

  it('un changement distant redessine le panneau, sauf la saisie en cours', () => {
    const { view, row } = mount(NOTE)
    const input = row('note').querySelector('[data-testid=\"property-value\"] input') as HTMLInputElement
    input.focus()
    input.value = 'en train de taper'
    const at = view.state.doc.toString().indexOf('priority: 2') + 'priority: '.length
    view.dispatch({ changes: { from: at, to: at + 1, insert: '7' } })
    expect((row('priority').querySelector('[data-testid=\"property-value\"] input') as HTMLInputElement).value).toBe('7')
    expect((row('note').querySelector('[data-testid=\"property-value\"] input') as HTMLInputElement).value).toBe('en train de taper')
  })
})
