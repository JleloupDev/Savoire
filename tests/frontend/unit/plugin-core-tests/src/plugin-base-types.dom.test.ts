// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// plugin-base : types de proprietes (statut, adresse web, e-mail, fichiers,
// personnes, numero unique, cree / modifie le et par), formats, couleurs,
// menus de choix, reglages d'une propriete et renommages.
import { describe, it, expect } from 'vitest'
import { coercePropertyValue, formatNumber, guessPropertyType, parseFrontmatter } from '@savoire/plugin-api'
import { cell, click, mount, tick, world } from './baseHarness'

const choose = async (value: string) => {
  const item = Array.from(document.querySelectorAll('[data-testid="base-choice"]')).find(e => (e as HTMLElement).dataset.value === value) as HTMLElement
  item.click()
  await tick()
}

describe('types des proprietes', () => {
  it('valeurs : listes, periodes, nombres formates', () => {
    expect(coercePropertyValue('[[A]]', 'relation')).toEqual(['[[A]]'])
    expect(coercePropertyValue(['u1', 'u2'], 'person')).toEqual(['u1', 'u2'])
    expect(coercePropertyValue('12', 'id')).toBe(12)
    expect(guessPropertyType('2026-11-24/2026-11-30')).toBe('date')
    expect(formatNumber(1234.5, 'euro')).toMatch(/1\s?234,50\s?€/)
    expect(formatNumber(42, 'percent')).toBe('42 %')
  })

  it('affichage : statut colore, adresse, e-mail, date lisible, nombre en barre', async () => {
    const w = world([
      { path: 'Projets/Alpha.md', text: '---\netat: En cours\nsite: https://www.exemple.fr/\nmail: a@b.fr\nquand: 2026-11-24/2026-11-30\nprix: 12.5\navancement: 40\n---\n' },
    ])
    const a = w.member(0)
    a.types.set({ key: 'etat', type: 'status', options: [{ value: 'En cours', color: 'blue', group: 'doing' }] })
    a.types.set({ key: 'site', type: 'url' })
    a.types.set({ key: 'mail', type: 'email' })
    a.types.set({ key: 'quand', type: 'date' })
    a.types.set({ key: 'prix', type: 'number', format: 'euro' })
    a.types.set({ key: 'avancement', type: 'number', display: 'bar' })
    const { el } = await mount(w, 0, a.api)
    await tick(120)
    const etat = cell(el, 'Alpha', 'etat')
    expect(etat.querySelector('.base-pill.base-color-blue')).not.toBeNull()
    expect(etat.querySelector('.base-status-doing')).not.toBeNull()
    const site = cell(el, 'Alpha', 'site').querySelector('a')!
    expect(site.textContent).toBe('exemple.fr')
    expect(site.getAttribute('href')).toBe('https://www.exemple.fr/')
    expect(cell(el, 'Alpha', 'mail').querySelector('a')!.getAttribute('href')).toBe('mailto:a@b.fr')
    expect(cell(el, 'Alpha', 'quand').textContent).toBe('24 nov. → 30 nov. 2026')
    expect(cell(el, 'Alpha', 'prix').textContent).toMatch(/12,50\s?€/)
    expect(cell(el, 'Alpha', 'avancement').querySelector('.base-bar-fill')!.getAttribute('style')).toContain('40%')
  })

  it('menu de choix : choisir, creer une option, choix multiple, personnes', async () => {
    const w = world([{ path: 'Projets/Alpha.md', text: '---\netat: Pas commencé\n---\n' }])
    const a = w.member(0)
    a.types.set({ key: 'etat', type: 'status', options: [
      { value: 'Pas commencé', group: 'todo' }, { value: 'En cours', group: 'doing' }, { value: 'Terminé', group: 'done' },
    ] })
    a.types.set({ key: 'tags', type: 'multiselect', options: [{ value: 'rouge', color: 'red' }] })
    a.types.set({ key: 'qui', type: 'person', multiple: true })
    const { el } = await mount(w, 0, a.api)
    await tick(120)
    // Les colonnes viennent du manifeste : on ajoute tags et qui.
    for (const key of ['tags', 'qui']) {
      click(el.querySelector('[data-testid="base-add-column"]'))
      ;(el.querySelector('[data-testid="base-new-column-name"]') as HTMLInputElement).value = key
      click(el.querySelector('[data-testid="base-new-column-ok"]'))
      await tick()
    }
    // Statut : les groupes s'affichent, un clic choisit.
    cell(el, 'Alpha', 'etat').dispatchEvent(new MouseEvent('dblclick'))
    await tick()
    expect(Array.from(document.querySelectorAll('.base-choice-group')).map(g => g.textContent)).toEqual(['À faire', 'En cours', 'Terminé'])
    await choose('En cours')
    await tick()
    expect(parseFrontmatter(w.notes[0].text).etat).toBe('En cours')
    expect(document.querySelector('[data-testid="base-choice-menu"]')).toBeNull()

    // Choix multiple : on coche, on cree, on valide en quittant.
    cell(el, 'Alpha', 'tags').dispatchEvent(new MouseEvent('dblclick'))
    await tick()
    await choose('rouge')
    const input = cell(el, 'Alpha', 'tags').querySelector('[data-testid="base-editor"]') as HTMLInputElement
    input.value = 'vert'
    input.dispatchEvent(new Event('input'))
    await tick()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await tick()
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await tick()
    expect(parseFrontmatter(w.notes[0].text).tags).toEqual(['rouge', 'vert'])
    // « vert » est devenu une option du type.
    expect(a.types.get('tags')!.options!.map(o => o.value)).toEqual(['rouge', 'vert'])

    // Plusieurs personnes : des noms, pas des ids.
    cell(el, 'Alpha', 'qui').dispatchEvent(new MouseEvent('dblclick'))
    await tick()
    await choose('u1')
    await choose('u2')
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await tick(120)
    expect(parseFrontmatter(w.notes[0].text).qui).toEqual(['u1', 'u2'])
    expect(cell(el, 'Alpha', 'qui').textContent).toBe('AAliceBBob')
  })

  it('valeurs posees par l appli : numero, cree le / par, modifie le / par', async () => {
    const w = world([{ path: 'Projets/Alpha.md', text: '---\nnum: 7\n---\n' }])
    const a = w.member(0)
    a.types.set({ key: 'num', type: 'id', prefix: 'T' })
    a.types.set({ key: 'cree', type: 'created' })
    a.types.set({ key: 'auteur', type: 'createdBy' })
    a.types.set({ key: 'maj', type: 'modifiedBy' })
    a.types.set({ key: 'note', type: 'text' })
    const { el } = await mount(w, 0, a.api)
    await tick(120)
    for (const key of ['cree', 'auteur', 'maj', 'note']) {
      click(el.querySelector('[data-testid="base-add-column"]'))
      ;(el.querySelector('[data-testid="base-new-column-name"]') as HTMLInputElement).value = key
      click(el.querySelector('[data-testid="base-new-column-ok"]'))
      await tick()
    }
    expect(cell(el, 'Alpha', 'num').textContent).toBe('T-7')
    click(el.querySelector('[data-testid="base-new-page"]'))
    await tick(150)
    const page = w.notes.find(n => n.path === 'Projets/Sans titre.md')!
    const fm = parseFrontmatter(page.text)
    expect(fm.num).toBe(8)
    expect(fm.auteur).toBe('u1')
    expect(String(fm.cree)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    // Une valeur posee ne se modifie pas a la main.
    cell(el, 'Alpha', 'num').dispatchEvent(new MouseEvent('dblclick'))
    expect(cell(el, 'Alpha', 'num').querySelector('[data-testid="base-editor"]')).toBeNull()
    // Modifier une cellule note qui l'a fait.
    const note = cell(el, 'Alpha', 'note')
    note.dispatchEvent(new MouseEvent('dblclick'))
    const input = note.querySelector('[data-testid="base-editor"]') as HTMLInputElement
    input.value = 'vu'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await tick()
    expect(parseFrontmatter(w.notes[0].text)).toMatchObject({ note: 'vu', maj: 'u1' })
  })

  it('reglages : options et couleurs, renommer une valeur et une cle partout', async () => {
    const w = world([
      { path: 'Projets/Alpha.md', text: '---\netat: Fait\n---\n' },
      { path: 'Projets/Beta.md', text: '---\netat: A faire\n---\n' },
    ])
    const a = w.member(0)
    a.types.set({ key: 'etat', type: 'select', options: [{ value: 'Fait' }, { value: 'A faire' }] })
    const { el } = await mount(w, 0, a.api)
    await tick(120)
    click(el.querySelector('[data-testid="base-th"][data-key="etat"] .base-th-label'))
    click(el.querySelector('[data-testid="base-col-settings"]'))
    await tick()
    const settings = () => el.querySelector('[data-testid="base-property-settings"]') as HTMLElement
    expect(settings()).not.toBeNull()
    // Couleur d'une option.
    const color = settings().querySelector('[data-testid="base-option-color"]') as HTMLSelectElement
    color.value = 'green'
    color.dispatchEvent(new Event('change'))
    await tick()
    expect(a.types.get('etat')!.options![0]).toEqual({ value: 'Fait', color: 'green' })
    expect(cell(el, 'Alpha', 'etat').querySelector('.base-color-green')).not.toBeNull()
    // Renommer l'option : les lignes suivent.
    const value = settings().querySelector('[data-testid="base-option-value"]') as HTMLInputElement
    value.value = 'Terminé'
    value.dispatchEvent(new Event('change'))
    await tick(150)
    expect(parseFrontmatter(w.notes[0].text).etat).toBe('Terminé')
    expect(parseFrontmatter(w.notes[1].text).etat).toBe('A faire')
    // Nom affiche : la cle ne change pas.
    const label = settings().querySelector('[data-testid="base-setting-label"]') as HTMLInputElement
    label.value = 'État'
    label.dispatchEvent(new Event('change'))
    await tick()
    expect(el.querySelector('[data-testid="base-th"][data-key="etat"]')!.textContent).toContain('État')
    // Renommer la cle dans les notes.
    const key = settings().querySelector('[data-testid="base-setting-key"]') as HTMLInputElement
    key.value = 'statut'
    click(settings().querySelector('[data-testid="base-setting-rename"]'))
    await tick(200)
    expect(parseFrontmatter(w.notes[0].text)).toEqual({ statut: 'Terminé' })
    expect(parseFrontmatter(w.notes[1].text)).toEqual({ statut: 'A faire' })
    expect(a.types.get('statut')!.type).toBe('select')
    expect(el.querySelector('[data-testid="base-th"][data-key="statut"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="base-th"][data-key="etat"]')).toBeNull()
  })
})
