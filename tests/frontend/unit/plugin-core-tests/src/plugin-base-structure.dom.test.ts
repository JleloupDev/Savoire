// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// plugin-base : automatisations, boutons, modeles de ligne (par defaut,
// repetes), sous-elements, verrou de la structure.
import { describe, it, expect } from 'vitest'
import { parseFrontmatter } from '@savoire/plugin-api'
import { periodOf, dueTemplates, triggered, actionValues } from '@savoire/plugin-base'
import { cell, click, mount, tick, titles, world } from './baseHarness'

const NOTES = [
  { path: 'Projets/Alpha.md', text: '---\nstatus: En cours\n---\n' },
  { path: 'Projets/Beta.md', text: '---\nstatus: Fait\n---\n' },
]

async function setup(notes = NOTES) {
  const w = world(notes)
  const a = w.member(0)
  const m = await mount(w, 0, a.api)
  await tick(150)
  return { w, a, ...m }
}

const select = (el: Element | null, value: string) => {
  const s = el as HTMLSelectElement
  s.value = value
  s.dispatchEvent(new Event('change'))
}

describe('structure des bases', () => {
  it('periodes, declencheurs et valeurs des actions', () => {
    const d = new Date(2026, 10, 24)
    expect(periodOf('daily', d)).toBe('2026-11-24')
    expect(periodOf('weekly', d)).toBe('2026-S48')
    expect(periodOf('monthly', d)).toBe('2026-11')
    expect(dueTemplates({ defaultTemplate: '', repeats: { a: { every: 'daily', last: '2026-11-23' }, b: { every: 'monthly', last: '2026-11' } } }, d))
      .toEqual([{ path: 'a', period: '2026-11-24' }])
    const list = [{ id: '1', name: '', enabled: true, when: { kind: 'changed' as const, key: 'status', value: 'Fait' }, then: [{ kind: 'now' as const, key: 'fini' }] }]
    expect(triggered(list, 'status', 'Fait')).toHaveLength(1)
    expect(triggered(list, 'status', 'En cours')).toHaveLength(0)
    expect(actionValues([{ kind: 'me', key: 'qui' }, { kind: 'set', key: 'x', value: 2 }], { now: 'n', me: 'u1', multiple: () => true })).toEqual({ qui: ['u1'], x: 2 })
  })

  it('automatisation : quand le statut passe a Fait, la ligne m est attribuee', async () => {
    const { el, w, a } = await setup()
    a.types.set({ key: 'qui', type: 'person' })
    await tick(50)
    click(el.querySelector('[data-testid="base-more"]'))
    click(el.querySelector('[data-testid="base-automations"]'))
    select(el.querySelector('[data-testid="base-automation-trigger"]'), 'changed')
    select(el.querySelector('[data-testid="base-automation-when-key"]'), 'status')
    ;(el.querySelector('[data-testid="base-automation-when-value"]') as HTMLInputElement).value = 'Fait'
    select(el.querySelector('[data-testid="base-automation-action-kind"]'), 'me')
    select(el.querySelector('[data-testid="base-automation-action-key"]'), 'qui')
    click(el.querySelector('[data-testid="base-automation-add"]'))
    await tick(50)
    expect(el.querySelectorAll('[data-testid="base-automation"]')).toHaveLength(1)
    const edit = async (title: string, value: string) => {
      const td = cell(el, title, 'status')
      td.dispatchEvent(new MouseEvent('dblclick'))
      const input = td.querySelector('[data-testid="base-editor"]') as HTMLInputElement
      input.value = value
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
      await tick(100)
    }
    await edit('Alpha', 'Bloqué')
    expect(parseFrontmatter(w.notes[0].text).qui).toBeUndefined()
    await edit('Alpha', 'Fait')
    expect(parseFrontmatter(w.notes[0].text)).toEqual({ status: 'Fait', qui: 'u1' })
  })

  it('automatisation a la creation et colonne bouton', async () => {
    const { el, w, view } = await setup()
    // Automatisation : une page ajoutee prend le statut « À faire ».
    click(el.querySelector('[data-testid="base-more"]'))
    click(el.querySelector('[data-testid="base-automations"]'))
    select(el.querySelector('[data-testid="base-automation-action-key"]'), 'status')
    ;(el.querySelector('[data-testid="base-automation-action-value"]') as HTMLInputElement).value = 'À faire'
    click(el.querySelector('[data-testid="base-automation-add"]'))
    await tick(50)
    await (view as unknown as { addPage(): Promise<void> }).addPage()
    await tick(100)
    expect(parseFrontmatter(w.notes.find(n => n.path === 'Projets/Sans titre.md')!.text).status).toBe('À faire')
    // Colonne bouton : « Terminer » met le statut a Fait.
    click(el.querySelector('[data-testid="base-add-column"]'))
    ;(el.querySelector('[data-testid="base-new-column-name"]') as HTMLInputElement).value = 'Action'
    select(el.querySelector('[data-testid="base-new-column-type"]'), 'button')
    ;(el.querySelector('[data-testid="base-button-label"]') as HTMLInputElement).value = 'Terminer'
    select(el.querySelector('[data-testid="base-button-action-key"]'), 'status')
    ;(el.querySelector('[data-testid="base-button-action-value"]') as HTMLInputElement).value = 'Fait'
    click(el.querySelector('[data-testid="base-button-ok"]'))
    await tick(100)
    const b = cell(el, 'Alpha', '=Action').querySelector('[data-testid="base-cell-button"]') as HTMLButtonElement
    expect(b.textContent).toBe('Terminer')
    b.click()
    await tick(100)
    expect(parseFrontmatter(w.notes[0].text).status).toBe('Fait')
  })

  it('modeles : une page depuis un modele, le modele par defaut, la repetition', async () => {
    const { el, w } = await setup([
      ...NOTES,
      { path: 'Modèles/Projets/Réunion.md', text: '---\nstatus: Prévu\n---\n# {{title}}\nOrdre du jour du {{date}}' },
    ])
    click(el.querySelector('[data-testid="base-new-page-menu"]'))
    const use = el.querySelector('[data-testid="base-template-use"]') as HTMLElement
    expect(use.textContent).toContain('Réunion')
    use.click()
    await tick(150)
    const page = w.notes.find(n => n.path === 'Projets/Sans titre.md')!
    expect(parseFrontmatter(page.text).status).toBe('Prévu')
    expect(page.text).toContain('# Sans titre')
    expect(page.text).toMatch(/Ordre du jour du \d{4}-\d{2}-\d{2}/)
    // Par defaut : « + Page » utilise le modele.
    click(el.querySelector('[data-testid="base-new-page-menu"]'))
    const def = el.querySelector('[data-testid="base-template-default"]') as HTMLInputElement
    def.checked = true
    def.dispatchEvent(new Event('change'))
    await tick(50)
    click(el.querySelector('[data-testid="base-new-page"]'))
    await tick(150)
    expect(parseFrontmatter(w.notes.find(n => n.path === 'Projets/Sans titre 2.md')!.text).status).toBe('Prévu')
    // Repetition : la periode en cours est comptee comme faite.
    if (!el.querySelector('[data-testid="base-page-menu"]')) click(el.querySelector('[data-testid="base-new-page-menu"]'))
    select(el.querySelector('[data-testid="base-template-repeat"]'), 'daily')
    await tick(50)
    const tree = w.tree('base1', 0)
    const base = tree.root.get('base') as { get(k: string): unknown }
    const settings = JSON.parse(String(base.get('templates')))
    expect(settings.repeats['Modèles/Projets/Réunion.md'].every).toBe('daily')
  })

  it('sous-elements : relation Parent, enfants deplies, sous-element ajoute', async () => {
    const { el, w } = await setup([
      { path: 'Projets/Alpha.md', text: '---\nstatus: En cours\n---\n' },
      { path: 'Projets/Beta.md', text: '---\nParent:\n  - "[[Projets/Alpha]]"\n---\n' },
      { path: 'Projets/Gamma.md', text: '---\nstatus: Fait\n---\n' },
    ])
    click(el.querySelector('[data-testid="base-view-settings"]'))
    click(el.querySelector('[data-testid="base-layout-make-subitems"]'))
    await tick(200)
    expect(titles(el)).toEqual(['Alpha', 'Gamma'])
    const toggle = cell(el, 'Alpha', '@title').querySelector('[data-testid="base-sub-toggle"]') as HTMLElement
    expect(toggle.style.visibility).toBe('visible')
    toggle.click()
    await tick(150)
    expect(titles(el)).toEqual(['Alpha', 'Beta', 'Gamma'])
    click(cell(el, 'Gamma', '@title').querySelector('[data-testid="base-add-child"]'))
    await tick(200)
    const child = w.notes.find(n => n.path === 'Projets/Sans titre.md')!
    expect(parseFrontmatter(child.text).Parent).toEqual(['[[Projets/Gamma]]'])
    expect(titles(el)).toEqual(['Alpha', 'Beta', 'Gamma', 'Sans titre'])
  })

  it('verrou : colonnes et vues figees, valeurs modifiables', async () => {
    const { el, w } = await setup()
    click(el.querySelector('[data-testid="base-more"]'))
    click(el.querySelector('[data-testid="base-lock"]'))
    await tick(100)
    expect((el.querySelector('[data-testid="base-add-column"]') as HTMLButtonElement).disabled).toBe(true)
    expect(el.querySelector('[data-testid="base-add-view"]')).toBeNull()
    expect(el.querySelector('[data-testid="base-type-kanban"]')).toBeNull()
    const td = cell(el, 'Alpha', 'status')
    td.dispatchEvent(new MouseEvent('dblclick'))
    const input = td.querySelector('[data-testid="base-editor"]') as HTMLInputElement
    input.value = 'Fait'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await tick(100)
    expect(parseFrontmatter(w.notes[0].text).status).toBe('Fait')
    click(el.querySelector('[data-testid="base-more"]'))
    expect(el.querySelector('[data-testid="base-lock"]')!.textContent).toContain('Déverrouiller')
  })
})
