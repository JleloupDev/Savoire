// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Les onglets retenus par compte et par vault, et le dernier vault ouvert.
import { describe, it, expect } from 'vitest'
import { lastVault, loadTabs, rememberLastVault, saveTabs } from '../../../../../apps/web/src/openTabs'

function memory() {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, removeItem: (k: string) => { m.delete(k) }, size: () => m.size }
}

describe('onglets retenus', () => {
  it('par compte et par vault', () => {
    const store = memory()
    saveTabs('u1', 'A', { ids: ['x', 'y'], active: 'y' }, store)
    saveTabs('u1', 'B', { ids: ['z'] }, store)
    expect(loadTabs('u1', 'A', store)).toEqual({ ids: ['x', 'y'], active: 'y' })
    expect(loadTabs('u1', 'B', store)).toEqual({ ids: ['z'], active: undefined })
    expect(loadTabs('u2', 'A', store)).toEqual({ ids: [] })
  })

  it('sans onglet, rien n\'est garde ; un actif ferme est oublie', () => {
    const store = memory()
    saveTabs('u1', 'A', { ids: ['x'], active: 'gone' }, store)
    expect(loadTabs('u1', 'A', store).active).toBeUndefined()
    saveTabs('u1', 'A', { ids: [] }, store)
    expect(store.size()).toBe(0)
  })

  it('les plus anciens tombent au-dela de 30, sans doublon', () => {
    const store = memory()
    const ids = Array.from({ length: 40 }, (_, i) => `d${i}`)
    saveTabs('u1', 'A', { ids: [...ids, 'd39'] }, store)
    const saved = loadTabs('u1', 'A', store).ids
    expect(saved).toHaveLength(30)
    expect(saved[0]).toBe('d10')
  })

  it('une valeur abimee ne casse rien', () => {
    const store = memory()
    store.setItem('savoire-open-tabs:u1:A', '{pas du json')
    expect(loadTabs('u1', 'A', store)).toEqual({ ids: [] })
  })

  it('retient le dernier vault du compte', () => {
    const store = memory()
    rememberLastVault('u1', 'A', store)
    expect(lastVault('u1', store)).toBe('A')
    rememberLastVault('u1', null, store)
    expect(lastVault('u1', store)).toBeNull()
  })
})
