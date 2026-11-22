// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Dictee (apps/web/src/dictation.ts) : le texte dicte s'ecrit au curseur.
import { describe, it, expect } from 'vitest'
import { insertDictated } from '../../../../../apps/web/src/dictation'

function fakeView(text: string, at: number) {
  const v = {
    text, cursor: at,
    state: {
      get selection() { return { main: { from: v.cursor, to: v.cursor } } },
      doc: { get length() { return v.text.length }, sliceString: (a: number, b: number) => v.text.slice(a, b) },
    },
    dispatch(tr: { changes?: { from: number; to: number; insert: string }; selection?: { anchor: number } }) {
      if (tr.changes) v.text = v.text.slice(0, tr.changes.from) + tr.changes.insert + v.text.slice(tr.changes.to)
      if (tr.selection) v.cursor = tr.selection.anchor
    },
  }
  return v
}

describe('dictée', () => {
  it('écrit au curseur, avec une espace après un mot, et place le curseur après', () => {
    const v = fakeView('Bonjour', 7)
    insertDictated(v, ' le monde. ')
    expect(v.text).toBe('Bonjour le monde.')
    insertDictated(v, 'Suite')
    expect(v.text).toBe('Bonjour le monde. Suite')
    expect(v.cursor).toBe(v.text.length)
  })

  it('pas d’espace en début de ligne ; rien pour un texte vide', () => {
    const v = fakeView('A\n', 2)
    insertDictated(v, 'Ligne')
    expect(v.text).toBe('A\nLigne')
    insertDictated(v, '   ')
    expect(v.text).toBe('A\nLigne')
  })
})

describe('dictée par morceaux', () => {
  it('coupe à une pause après de la parole, jamais dans le silence', async () => {
    const { SilenceSegmenter } = await import('../../../../../apps/web/src/dictation')
    const seg = new SilenceSegmenter(0)
    let t = 0
    const feed = (rms: number, ms: number) => { let cut = false; for (const end = t + ms; t < end; t += 100) cut = seg.feed(rms, t) || cut; return cut }
    expect(feed(0.001, 3000)).toBe(false) // silence : rien
    expect(seg.hasVoice).toBe(false)
    expect(feed(0.1, 1500)).toBe(false) // on parle
    expect(feed(0.001, 1000)).toBe(true) // pause : on coupe
    seg.reset(t)
    expect(seg.hasVoice).toBe(false)
  })

  it('un long monologue est coupé au plus tard', async () => {
    const { SilenceSegmenter } = await import('../../../../../apps/web/src/dictation')
    const seg = new SilenceSegmenter(0, { maxMs: 5000 })
    let cut = false
    for (let t = 0; t <= 5000 && !cut; t += 100) cut = seg.feed(0.2, t)
    expect(cut).toBe(true)
  })
})
