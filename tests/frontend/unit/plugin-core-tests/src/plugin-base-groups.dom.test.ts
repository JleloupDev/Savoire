// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// plugin-base : tableau groupe (ordre des options, groupes repliables, par
// mois), sous-groupes du kanban.
import { describe, it, expect } from 'vitest'
import { parseFrontmatter } from '@savoire/plugin-api'
import { orderGroups, groupLabel } from '@savoire/plugin-base'
import { click, mount, tick, world } from './baseHarness'

const NOTES = [
  { path: 'Projets/Alpha.md', text: '---\netat: En cours\nqui: u1\nquand: 2026-11-03\n---\n' },
  { path: 'Projets/Beta.md', text: '---\netat: Fait\nqui: u2\nquand: 2026-11-20\n---\n' },
  { path: 'Projets/Gamma.md', text: '---\netat: En cours\nqui: u2\nquand: 2026-12-01\n---\n' },
  { path: 'Projets/Delta.md', text: '---\nqui: u1\n---\n' },
]

const headText = (head: Element) => (head.textContent ?? '').replace('▾', '')
const sections = (el: HTMLElement) => Array.from(el.querySelectorAll('[data-testid="base-group-section"]')).map(g => ({
  head: headText(g.querySelector('[data-testid="base-group-head"]')!),
  rows: Array.from(g.querySelectorAll('[data-testid="base-row"] [data-testid="base-title"]')).map(t => t.textContent),
}))

describe('groupes', () => {
  it('ordre des groupes et libelles', () => {
    expect(orderGroups(['b', null, 'Fait', 'a'], 'select', [{ value: 'Fait' }])).toEqual(['Fait', 'a', 'b', null])
    expect(orderGroups([false, true], 'checkbox')).toEqual([true, false])
    expect(groupLabel('2026-11', 'date', 'month')).toBe('novembre 2026')
    expect(groupLabel('2026-S48', 'date', 'week')).toBe('Semaine 48, 2026')
  })

  it('tableau groupe : sections dans l ordre des options, repliables, nouvelle page dans un groupe', async () => {
    const w = world(NOTES)
    const a = w.member(0)
    a.types.set({ key: 'etat', type: 'select', options: [{ value: 'Fait' }, { value: 'En cours' }, { value: 'Annulé' }] })
    a.types.set({ key: 'quand', type: 'date' })
    const { el } = await mount(w, 0, a.api)
    await tick(150)
    click(el.querySelector('[data-testid="base-group"]'))
    const by = el.querySelector('[data-testid="base-group-by"]') as HTMLSelectElement
    by.value = 'etat'
    by.dispatchEvent(new Event('change'))
    await tick(200)
    expect(sections(el)).toEqual([
      { head: 'Fait1', rows: ['Beta'] },
      { head: 'En cours2', rows: ['Alpha', 'Gamma'] },
      { head: 'Annulé0', rows: [] },
      { head: 'Sans valeur1', rows: ['Delta'] },
    ])
    // Masquer les groupes vides.
    const hide = el.querySelector('[data-testid="base-group-hide-empty"]') as HTMLInputElement
    hide.checked = true
    hide.dispatchEvent(new Event('change'))
    await tick(200)
    expect(sections(el).map(s => s.head)).toEqual(['Fait1', 'En cours2', 'Sans valeur1'])
    // Replier « En cours ».
    click(el.querySelectorAll('[data-testid="base-group-toggle"]')[1])
    await tick(200)
    expect(sections(el)[1]).toEqual({ head: 'En cours2', rows: [] })
    // Nouvelle page dans le groupe « Fait » : elle en prend la valeur.
    click(el.querySelector('[data-testid="base-group-section"] [data-testid="base-add-row-bottom"]'))
    await tick(200)
    const page = w.notes.find(n => n.path === 'Projets/Sans titre.md')!
    expect(parseFrontmatter(page.text).etat).toBe('Fait')

    // Par mois.
    const by2 = el.querySelector('[data-testid="base-group-by"]') as HTMLSelectElement
    by2.value = 'quand'
    by2.dispatchEvent(new Event('change'))
    await tick(100)
    const dates = el.querySelector('[data-testid="base-group-date"]') as HTMLSelectElement
    dates.value = 'month'
    dates.dispatchEvent(new Event('change'))
    await tick(300)
    expect(sections(el).map(s => s.head)).toEqual(['novembre 20262', 'décembre 20261', 'Sans valeur2'])
    expect(sections(el)[0].rows).toEqual(['Alpha', 'Beta'])
  })

  it('kanban : sous-groupes par personne', async () => {
    const w = world(NOTES)
    const a = w.member(0)
    a.types.set({ key: 'etat', type: 'select', options: [{ value: 'Fait' }, { value: 'En cours' }] })
    a.types.set({ key: 'qui', type: 'person' })
    const { el } = await mount(w, 0, a.api)
    await tick(150)
    click(el.querySelector('[data-testid="base-type-kanban"]'))
    await tick(100)
    click(el.querySelector('[data-testid="base-group"]'))
    const by = el.querySelector('[data-testid="base-group-by"]') as HTMLSelectElement
    by.value = 'etat'
    by.dispatchEvent(new Event('change'))
    await tick(100)
    const sub = el.querySelector('[data-testid="base-subgroup-by"]') as HTMLSelectElement
    sub.value = 'qui'
    sub.dispatchEvent(new Event('change'))
    await tick(300)
    const lanes = Array.from(el.querySelectorAll('[data-testid="base-swimlane"]'))
    expect(lanes.map(l => headText(l.querySelector('.base-group-head')!))).toEqual(['AAlice2', 'BBob2'])
    const cards = (lane: Element, value: string) => Array.from(lane.querySelectorAll(`[data-testid="base-lane"][data-value="${value}"] [data-testid="base-card"] .base-card-title`)).map(c => c.textContent)
    expect(cards(lanes[0], 'En cours')).toEqual(['Alpha'])
    expect(cards(lanes[1], 'En cours')).toEqual(['Gamma'])
    expect(cards(lanes[1], 'Fait')).toEqual(['Beta'])
  })
})
