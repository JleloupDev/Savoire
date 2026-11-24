// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// plugin-base : relations entre deux bases (menu des lignes, lien retour) et
// rollups (somme des heures des taches d'un projet, filtre dessus).
import { describe, it, expect } from 'vitest'
import { parseFrontmatter } from '@savoire/plugin-api'
import { cell, click, mount, tick, titles, world } from './baseHarness'

const NOTES = [
  { path: 'Projets/Alpha.md', text: '---\ntaches:\n  - "[[Taches/T1]]"\n  - "[[Taches/T2]]"\n---\n' },
  { path: 'Projets/Beta.md', text: '---\ntaches:\n  - "[[Taches/T3]]"\n---\n' },
  { path: 'Taches/T1.md', text: '---\nprojet:\n  - "[[Projets/Alpha]]"\nheures: 3\n---\n' },
  { path: 'Taches/T2.md', text: '---\nprojet:\n  - "[[Projets/Alpha]]"\nheures: 5\n---\n' },
  { path: 'Taches/T3.md', text: '---\nprojet:\n  - "[[Projets/Beta]]"\nheures: 2\n---\n' },
]
const TACHES = { id: 'base2', path: 'Taches.base' }

describe('relations et rollups', () => {
  it('une relation montre les noms des lignes liees ; le menu lie, le lien retour suit', async () => {
    const w = world(NOTES, [TACHES])
    const a = w.member(0)
    a.types.set({ key: 'projet', type: 'relation', relation: { base: 'base1', back: 'taches' } })
    a.types.set({ key: 'taches', type: 'relation', relation: { base: 'base2', back: 'projet' } })
    a.types.set({ key: 'heures', type: 'number' })
    const { el } = await mount(w, 0, a.api, TACHES)
    await tick(300)
    expect(titles(el)).toEqual(['T1', 'T2', 'T3'])
    expect(cell(el, 'T1', 'projet').textContent).toBe('Alpha')

    // T3 rejoint Alpha (en plus de Beta) par le menu.
    cell(el, 'T3', 'projet').dispatchEvent(new MouseEvent('dblclick'))
    await tick(200)
    const choices = Array.from(document.querySelectorAll('[data-testid="base-choice"]')) as HTMLElement[]
    expect(choices.map(c => c.textContent)).toEqual(['☐AlphaProjets', '☑BetaProjets'])
    choices[0].click()
    await tick()
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await tick(200)
    const t3 = w.notes.find(n => n.path === 'Taches/T3.md')!
    expect(parseFrontmatter(t3.text).projet).toEqual(['[[Projets/Beta]]', '[[Projets/Alpha]]'])
    // Lien retour : Alpha pointe vers T3.
    const alpha = w.notes.find(n => n.path === 'Projets/Alpha.md')!
    expect(parseFrontmatter(alpha.text).taches).toEqual(['[[Taches/T1]]', '[[Taches/T2]]', '[[Taches/T3]]'])

    // Retirer Beta : Beta ne pointe plus vers T3.
    cell(el, 'T3', 'projet').dispatchEvent(new MouseEvent('dblclick'))
    await tick(200)
    ;(Array.from(document.querySelectorAll('[data-testid="base-choice"]')) as HTMLElement[]).find(c => c.dataset.value === '[[Projets/Beta]]')!.click()
    await tick()
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await tick(200)
    const beta = w.notes.find(n => n.path === 'Projets/Beta.md')!
    expect(parseFrontmatter(beta.text).taches).toBeUndefined()
  })

  it('rollup : somme des heures des taches liees, recalculee, filtrable', async () => {
    const w = world(NOTES, [TACHES])
    const a = w.member(0)
    a.types.set({ key: 'taches', type: 'relation', relation: { base: 'base2' } })
    a.types.set({ key: 'heures', type: 'number' })
    const { el } = await mount(w, 0, a.api)
    await tick(200)
    expect(titles(el)).toEqual(['Alpha', 'Beta'])
    // Nouvelle colonne rollup.
    click(el.querySelector('[data-testid="base-add-column"]'))
    ;(el.querySelector('[data-testid="base-new-column-name"]') as HTMLInputElement).value = 'Heures'
    const type = el.querySelector('[data-testid="base-new-column-type"]') as HTMLSelectElement
    type.value = 'rollup'
    type.dispatchEvent(new Event('change'))
    await tick(300)
    const editor = el.querySelector('[data-testid="base-rollup-editor"]') as HTMLElement
    expect((editor.querySelector('[data-testid="base-rollup-relation"]') as HTMLSelectElement).value).toBe('taches')
    const prop = editor.querySelector('[data-testid="base-rollup-prop"]') as HTMLSelectElement
    expect(Array.from(prop.options).map(o => o.value)).toContain('heures')
    prop.value = 'heures'
    const calc = editor.querySelector('[data-testid="base-rollup-calc"]') as HTMLSelectElement
    calc.value = 'sum'
    click(editor.querySelector('[data-testid="base-rollup-ok"]'))
    await tick(300)
    expect(cell(el, 'Alpha', '=Heures').textContent).toBe('8')
    expect(cell(el, 'Beta', '=Heures').textContent).toBe('2')

    // Une tache change : le rollup suit.
    const t2 = w.notes.find(n => n.path === 'Taches/T2.md')!
    t2.text = t2.text.replace('heures: 5', 'heures: 7')
    w.notify()
    await tick(400)
    expect(cell(el, 'Alpha', '=Heures').textContent).toBe('10')

    // Filtre sur le rollup (calcule dans le client).
    click(el.querySelector('[data-testid="base-filter"]'))
    click(el.querySelector('[data-testid="base-filters-add"]'))
    await tick()
    const key = el.querySelector('[data-testid="base-filters"] [data-testid="base-filter-key"]') as HTMLSelectElement
    key.value = '=Heures'
    key.dispatchEvent(new Event('change'))
    await tick()
    const op = el.querySelector('[data-testid="base-filters"] [data-testid="base-filter-op"]') as HTMLSelectElement
    op.value = 'contains'
    const value = el.querySelector('[data-testid="base-filters"] [data-testid="base-filter-value"]') as HTMLInputElement
    value.value = '10'
    value.dispatchEvent(new Event('change'))
    await tick(400)
    expect(titles(el)).toEqual(['Alpha'])
  })
})
