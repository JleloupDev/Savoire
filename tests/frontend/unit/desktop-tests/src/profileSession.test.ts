// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le profil choisi par ?profile= reste celui de l'onglet apres un
// rechargement, meme quand l'adresse a perdu la requete.
import { describe, it, expect } from 'vitest'
import { PROFILE_SESSION_KEY, resolveProfile } from '../../../../../apps/web/src/profile'

const store = () => {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, m }
}

describe('profil de l onglet', () => {
  it('?profile= est retenu ; l adresse sans requete garde le profil choisi', () => {
    const s = store()
    expect(resolveProfile('?profile=local', s, false, false)).toBe('local')
    expect(s.m.get(PROFILE_SESSION_KEY)).toBe('local')
    expect(resolveProfile('', s, false, false)).toBe('local')
    // Un autre choix explicite remplace le premier.
    expect(resolveProfile('?profile=server', s, false, false)).toBe('server')
    expect(resolveProfile('', s, false, false)).toBe('server')
  })

  it('sans choix : le defaut ; valeur retenue inconnue ou refusee : le defaut', () => {
    expect(resolveProfile('', store(), false, false)).toBe('server')
    expect(resolveProfile('', store(), true, false)).toBe('desktop')
    const s = store(); s.m.set(PROFILE_SESSION_KEY, 'n-importe')
    expect(resolveProfile('', s, false, false)).toBe('server')
    // Profil bureau retenu, mais hors de Tauri : refuse.
    const d = store(); d.m.set(PROFILE_SESSION_KEY, 'desktop')
    expect(resolveProfile('', d, false, false)).toBe('server')
    // Stockage indisponible (navigation privee stricte).
    const broken = { getItem: () => { throw new Error('refuse') }, setItem: () => { throw new Error('refuse') } }
    expect(resolveProfile('?profile=local', broken, false, false)).toBe('local')
    expect(resolveProfile('', broken, false, false)).toBe('server')
    expect(resolveProfile('', null, false, false)).toBe('server')
  })
})
