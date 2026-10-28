// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le moteur de requetes en memoire passe le contrat commun (la reference
// des moteurs SQLite a venir), plus ses comportements propres.
import { describe, it, expect, vi } from 'vitest'
import { InMemoryQueryEngine, foldText } from '@savoire/plugin-runtime'
import { describeQueryEngineContract } from './contract/queryEngineContract'

describeQueryEngineContract('memoire', {
  async open(docs) {
    const engine = new InMemoryQueryEngine()
    for (const d of docs) engine.upsert(d)
    return {
      engine,
      upsert: async (d) => engine.upsert(d),
      remove: async (id) => engine.remove(id),
    }
  },
})

describe('InMemoryQueryEngine', () => {
  it('foldText ignore casse et accents', () => {
    expect(foldText('Électricité À FAIRE')).toBe('electricite a faire')
  })

  it('l etat de l index est rendu avec chaque resultat et signale aux abonnes', async () => {
    const engine = new InMemoryQueryEngine()
    const cb = vi.fn()
    engine.onStateChange(cb)
    engine.setState({ status: 'building', progress: 0.63 })
    expect(cb).toHaveBeenCalledWith({ status: 'building', progress: 0.63 })
    const r = await engine.query({ from: { notes: true } })
    expect(r.index).toEqual({ status: 'building', progress: 0.63 })
  })

  it('une requete annulee est refusee', async () => {
    const engine = new InMemoryQueryEngine()
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(engine.query({ from: { notes: true } }, { signal: ctrl.signal })).rejects.toMatchObject({ code: 'unavailable' })
  })
})
