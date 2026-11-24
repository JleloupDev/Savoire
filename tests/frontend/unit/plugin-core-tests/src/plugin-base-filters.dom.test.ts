// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// plugin-base : filtres « et » / « ou », groupes, dates relatives, « moi »,
// recherche rapide.
import { describe, it, expect } from 'vitest'
import { readFilters, toWhere, rangeOf, countFilters } from '@savoire/plugin-base'
import { click, mount, tick, titles, world } from './baseHarness'

const NOW = new Date(2026, 10, 24, 10, 30) // mardi 24 novembre 2026

/** Retire les filtres un a un (le popover se redessine apres chaque retrait). */
async function clearFilters(el: HTMLElement) {
  for (let i = 0; i < 10; i++) {
    const b = el.querySelector('[data-testid="base-filters"] > [data-testid="base-filter-row"] > [data-testid="base-filter-remove"]')
    if (!b) return
    click(b)
    await tick()
  }
}

describe('filtres des bases', () => {
  it('ou, groupes imbriques, filtres incomplets ignores', () => {
    const items = readFilters([
      { key: 'Statut', op: 'eq', value: 'Fait' },
      { mode: 'or', items: [{ key: 'Prix', op: 'gt', value: 10 }, { key: 'Prix', op: 'empty' }] },
      { key: 'Note', op: 'contains', value: '' },
      { key: 'x', op: 'inconnu' },
      'pas un filtre',
    ])
    expect(countFilters(items)).toBe(4)
    expect(toWhere(items, 'and')).toEqual({ and: [
      { field: { prop: 'Statut' }, op: 'eq', value: 'Fait' },
      { or: [{ field: { prop: 'Prix' }, op: 'gt', value: 10 }, { field: { prop: 'Prix' }, op: 'empty' }] },
    ] })
    expect(toWhere(items.slice(0, 1), 'or')).toEqual({ field: { prop: 'Statut' }, op: 'eq', value: 'Fait' })
    expect(toWhere([], 'and')).toBeUndefined()
  })

  it('dates relatives : un jour devient deux bornes, une periode aussi', () => {
    const typeOf = () => 'date' as const
    expect(toWhere([{ key: 'Echeance', op: 'eq', value: '@today' }], 'and', { now: NOW, typeOf })).toEqual({ and: [
      { field: { prop: 'Echeance' }, op: 'gte', value: '2026-11-24' },
      { field: { prop: 'Echeance' }, op: 'lt', value: '2026-11-25' },
    ] })
    expect(toWhere([{ key: 'Echeance', op: 'gt', value: '@tomorrow' }], 'and', { now: NOW, typeOf }))
      .toEqual({ field: { prop: 'Echeance' }, op: 'gte', value: '2026-11-26' })
    // Une date precise se compare aussi au jour (une date-heure du 24 est « le 24 »).
    expect(toWhere([{ key: 'Echeance', op: 'lte', value: '2026-11-24' }], 'and', { now: NOW, typeOf }))
      .toEqual({ field: { prop: 'Echeance' }, op: 'lt', value: '2026-11-25' })
    expect(rangeOf('@thisWeek', NOW)).toEqual(['2026-11-23', '2026-11-30'])
    expect(rangeOf('@thisMonth', NOW)).toEqual(['2026-11-01', '2026-12-01'])
    expect(rangeOf('@pastWeek', NOW)).toEqual(['2026-11-18', '2026-11-25'])
    expect(rangeOf('@nextWeek', NOW)).toEqual(['2026-11-24', '2026-12-01'])
    expect(toWhere([{ key: 'Echeance', op: 'within', value: '@thisYear' }], 'and', { now: NOW })).toEqual({ and: [
      { field: { prop: 'Echeance' }, op: 'gte', value: '2026-01-01' },
      { field: { prop: 'Echeance' }, op: 'lt', value: '2027-01-01' },
    ] })
  })

  it('« moi » : la personne connectee ; sans session, rien ne correspond', () => {
    expect(toWhere([{ key: 'Responsable', op: 'eq', value: '@me' }], 'and', { me: 'u1' }))
      .toEqual({ field: { prop: 'Responsable' }, op: 'eq', value: 'u1' })
    const none = toWhere([{ key: 'Responsable', op: 'eq', value: '@me' }], 'and', {}) as { value: string }
    expect(none.value).not.toBe('')
  })

  it('dans la vue : « ou » choisi a l ecran, groupe, dates, moi, recherche', async () => {
    const today = new Date()
    const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)
    const w = world([
      { path: 'Projets/Alpha.md', text: `---\nstatus: En cours\nqui: u1\nquand: ${iso(today)}T09:00\n---\n` },
      { path: 'Projets/Beta.md', text: `---\nstatus: Fait\nqui: u2\nquand: ${iso(tomorrow)}\n---\n` },
      { path: 'Projets/Gamma.md', text: '---\nstatus: Annulé\n---\n' },
    ])
    const a = w.member(0)
    a.types.set({ key: 'quand', type: 'date' })
    a.types.set({ key: 'qui', type: 'person' })
    const { el, view } = await mount(w, 0, a.api)
    await tick(120)
    expect(titles(el).sort()).toEqual(['Alpha', 'Beta', 'Gamma'])

    // Deux filtres sur le statut, relies par « ou ».
    click(el.querySelector('[data-testid="base-filter"]'))
    click(el.querySelector('[data-testid="base-filters-add"]'))
    await tick()
    const setRow = (i: number, key: string, op: string, value?: string) => {
      const row = el.querySelectorAll('[data-testid="base-filters"] > [data-testid="base-filter-row"]')[i] as HTMLElement
      const k = row.querySelector('[data-testid="base-filter-key"]') as HTMLSelectElement
      if (k.value !== key) { k.value = key; k.dispatchEvent(new Event('change')) }
      const again = el.querySelectorAll('[data-testid="base-filters"] > [data-testid="base-filter-row"]')[i] as HTMLElement
      const o = again.querySelector('[data-testid="base-filter-op"]') as HTMLSelectElement
      if (o.value !== op) { o.value = op; o.dispatchEvent(new Event('change')) }
      if (value !== undefined) {
        const v = (el.querySelectorAll('[data-testid="base-filters"] > [data-testid="base-filter-row"]')[i] as HTMLElement).querySelector('[data-testid="base-filter-value"]') as HTMLInputElement
        v.value = value
        v.dispatchEvent(new Event('change'))
      }
    }
    setRow(0, 'status', 'eq', 'Fait')
    await tick()
    click(el.querySelector('[data-testid="base-filters-add"]'))
    await tick()
    setRow(1, 'status', 'eq', 'Annulé')
    await tick(120)
    expect(titles(el)).toEqual([])
    const mode = el.querySelector('[data-testid="base-filters-mode"]') as HTMLSelectElement
    mode.value = 'or'
    mode.dispatchEvent(new Event('change'))
    await tick(120)
    expect(titles(el).sort()).toEqual(['Beta', 'Gamma'])
    expect(el.querySelector('[data-testid="base-filter"]')!.textContent).toContain('(2)')

    // Un groupe : (... ou ...) et « qui est moi ».
    view.destroy()
    const again = await mount(w, 0, a.api)
    await tick(120)
    const store = again.el
    click(store.querySelector('[data-testid="base-filter"]'))
    // On remplace par : qui est Moi.
    await clearFilters(store)
    click(store.querySelector('[data-testid="base-filters-add"]'))
    await tick()
    const row = store.querySelector('[data-testid="base-filters"] > [data-testid="base-filter-row"]') as HTMLElement
    const key = row.querySelector('[data-testid="base-filter-key"]') as HTMLSelectElement
    key.value = 'qui'; key.dispatchEvent(new Event('change'))
    await tick()
    const who = store.querySelector('[data-testid="base-filters"] [data-testid="base-filter-value"]') as HTMLSelectElement
    expect(Array.from(who.options).map(o => o.textContent)).toContain('Moi')
    who.value = '@me'; who.dispatchEvent(new Event('change'))
    await tick(120)
    expect(titles(store)).toEqual(['Alpha'])

    // Date : « est aujourd'hui » trouve la date-heure du jour.
    const k2 = store.querySelector('[data-testid="base-filters"] [data-testid="base-filter-key"]') as HTMLSelectElement
    k2.value = 'quand'; k2.dispatchEvent(new Event('change'))
    await tick()
    const rel = store.querySelector('[data-testid="base-filter-relative"]') as HTMLSelectElement
    rel.value = '@tomorrow'; rel.dispatchEvent(new Event('change'))
    await tick(120)
    expect(titles(store)).toEqual(['Beta'])
    const rel2 = store.querySelector('[data-testid="base-filter-relative"]') as HTMLSelectElement
    rel2.value = '@today'; rel2.dispatchEvent(new Event('change'))
    await tick(120)
    expect(titles(store)).toEqual(['Alpha'])

    // Groupe ajoute : il apparait, vide de sens tant qu'il est incomplet.
    click(store.querySelector('[data-testid="base-filters-add-group"]'))
    await tick(120)
    expect(store.querySelector('[data-testid="base-filters-group"]')).not.toBeNull()
    expect(titles(store)).toEqual(['Alpha'])
    again.view.destroy()

    // Recherche rapide : sur le nom, sans toucher au manifeste.
    const third = await mount(w, 0, a.api)
    await tick(120)
    click(third.el.querySelector('[data-testid="base-filter"]'))
    await clearFilters(third.el)
    const search = third.el.querySelector('[data-testid="base-search"]') as HTMLInputElement
    search.value = 'gam'
    search.dispatchEvent(new Event('input'))
    await tick(400)
    expect(titles(third.el)).toEqual(['Gamma'])
  })
})
