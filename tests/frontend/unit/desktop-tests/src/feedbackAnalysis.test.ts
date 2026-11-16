// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Analyse des retours (apps/web/src/feedbackAnalysis.ts) : ce qui part a
// l'IA, et la lecture de sa reponse.
import { describe, it, expect } from 'vitest'
import type { AIChatRequest } from '@savoire/plugin-api'
import { SimpleFeedbackAnalyzer, buildPrompt, parseAnalysis } from '../../../../../apps/web/src/feedbackAnalysis'
import type { FeedbackReport } from '../../../../../apps/web/src/feedback'

const report = (id: string, createdAt: string, message: string): FeedbackReport => ({
  id, userId: `u-${id}`, userName: `Personne ${id}`, userEmail: null, message,
  context: JSON.stringify({ platform: 'web', viewport: '1280x800', recentErrors: ['Boom'] }),
  userAgent: null, hasScreenshot: true, createdAt, archivedAt: null,
})

describe('buildPrompt', () => {
  it('met les plus recents d abord, avec le contexte', () => {
    const { text, count } = buildPrompt([report('a', '2026-11-01T10:00:00Z', 'Vieux'), report('b', '2026-11-10T10:00:00Z', 'Récent')])
    expect(count).toBe(2)
    expect(text.indexOf('[b]')).toBeLessThan(text.indexOf('[a]'))
    expect(text).toContain('web, 1280x800')
    expect(text).toContain('Erreurs récentes : Boom')
  })

  it('s arrete a la limite, mais garde toujours au moins un retour', () => {
    const many = Array.from({ length: 10 }, (_, i) => report(String(i), `2026-11-${10 + i}T00:00:00Z`, 'x'.repeat(100)))
    expect(buildPrompt(many, 250).count).toBe(1)
    expect(buildPrompt([report('long', '2026-11-01T00:00:00Z', 'y'.repeat(1000))], 10).count).toBe(1)
  })
})

describe('parseAnalysis', () => {
  it('lit le JSON, meme dans un bloc de code, et ne garde que les ids connus', () => {
    const text = '```json\n{"summary":"S","themes":[{"title":"T","description":"D","priority":"high","reportIds":["a","inconnu"]}],"suggestions":["Faire X"]}\n```'
    const r = parseAnalysis(text, new Set(['a']))
    expect(r.summary).toBe('S')
    expect(r.themes).toEqual([{ title: 'T', description: 'D', priority: 'high', reportIds: ['a'] }])
    expect(r.suggestions).toEqual(['Faire X'])
    expect(r.raw).toBeUndefined()
  })

  it('rend la reponse brute si ce n est pas du JSON', () => {
    expect(parseAnalysis('Voici mon avis', new Set()).raw).toBe('Voici mon avis')
  })
})

describe('SimpleFeedbackAnalyzer', () => {
  it('fait un seul appel en JSON et rend l analyse', async () => {
    const calls: AIChatRequest[] = []
    const analyzer = new SimpleFeedbackAnalyzer(async req => {
      calls.push(req)
      return { text: '{"summary":"Ok","themes":[],"suggestions":[]}', model: 'm', connection: 'c' }
    })
    const res = await analyzer.analyze([report('a', '2026-11-01T00:00:00Z', 'Trop lent')])
    expect(calls).toHaveLength(1)
    expect(calls[0].json).toBe(true)
    expect(calls[0].messages[1].content).toContain('Trop lent')
    expect(res).toMatchObject({ summary: 'Ok', analyzedCount: 1, model: 'm', connection: 'c' })
  })

  it('refuse une liste vide sans appeler l IA', async () => {
    const analyzer = new SimpleFeedbackAnalyzer(async () => { throw new Error('appel inattendu') })
    await expect(analyzer.analyze([])).rejects.toThrow('Aucun retour')
  })
})
