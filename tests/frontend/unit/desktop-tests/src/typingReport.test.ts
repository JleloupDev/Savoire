// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// L'editeur dit quand la personne tape (aiContext) : l'entree de contexte
// porte l'heure de la derniere frappe. Rien ne reagit a chaque touche : une
// frappe note l'heure, et l'entree part au plus une fois toutes les 2 s (la
// premiere tout de suite). Les agents de l'appli lisent ou elle tape
// (typingSpot), pendant 8 s.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { splitNoteBlocks } from '@savoire/plugin-api'

const NOTE = 'Premier paragraphe.\n\nCelui qu’elle écrit.\n\nUn troisième.'

/** Un editeur et sa note (vrai texte Yjs), que le test pilote. */
function fakeEditor(docId = 'd1') {
  const doc = new Y.Doc()
  const text = doc.getText('codemirror')
  text.insert(0, NOTE)
  let cursor = 0
  const handlers = new Map<string, Set<() => void>>()
  const collab = {
    toString: () => text.toString(),
    get length() { return text.length },
    slice: (a: number, b: number) => text.toString().slice(a, b),
    createRelPos: (i: number, assoc: number) => Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, i, assoc)),
    resolveRelPos: (rp: unknown) => Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(rp), doc)?.index ?? null,
  }
  const emit = (event: string) => { for (const cb of [...(handlers.get(event) ?? [])]) cb() }
  return {
    text,
    context: {
      editor: {
        on(event: string, cb: () => void) {
          if (!handlers.has(event)) handlers.set(event, new Set())
          handlers.get(event)!.add(cb)
          return () => { handlers.get(event)!.delete(cb) }
        },
        getSelectionRange: () => ({ from: cursor, to: cursor }),
      } as never,
      docId: () => docId, path: () => 'Plan.md', vaultId: () => 'v1',
      session: () => ({ openDocument: () => ({ collaborativeText: () => collab }), closeDocument: () => {} }) as never,
    },
    /** Elle tape un caractere a cet endroit. */
    type(at: number, char = 'x') { text.insert(at, char); cursor = at + char.length; emit('userTyped'); emit('selectionChanged') },
    /** Elle place son curseur, sans taper. */
    moveTo(at: number) { cursor = at; emit('selectionChanged') },
  }
}

async function load() {
  vi.resetModules()
  return import('../../../../../apps/web/src/aiContext')
}

let posted: { typingAt?: number; at: number; blockHash: string }[]

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-25T10:00:00Z'))
  posted = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => { posted.push(JSON.parse(init.body)); return { status: 204 } }))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('l editeur dit quand la personne tape', () => {
  it('une selection sans frappe ne dit rien ; la premiere frappe part tout de suite, avec son heure', async () => {
    const ai = await load()
    const e = fakeEditor()
    ai.setAiServer({ token: () => 'jeton', url: p => p })
    ai.setAiEditor(e.context)
    await vi.advanceTimersByTimeAsync(400)
    expect(posted).toHaveLength(1)
    expect(posted[0]!.typingAt).toBeUndefined()
    expect(ai.typingSpot('d1')).toBeNull()

    await vi.advanceTimersByTimeAsync(5000)
    const typedAt = Date.now()
    e.type(NOTE.indexOf('écrit.') + 'écrit.'.length)
    await vi.advanceTimersByTimeAsync(20)
    expect(posted).toHaveLength(2)
    expect(posted[1]!.typingAt).toBe(typedAt)
    // Le bloc ou elle tape, tel qu'il est maintenant.
    const block = splitNoteBlocks(e.text.toString()).find(b => b.text.startsWith('Celui'))!
    expect(posted[1]!.blockHash).toBe(block.hash)
    const spot = ai.typingSpot('d1')
    expect(spot).toMatchObject({ docId: 'd1', blockHash: block.hash })
    expect(spot!.ageMs).toBeLessThan(100)
    expect(spot!.anchor!.start).toBeTruthy()
    // Une autre note : elle n'y tape pas.
    expect(ai.typingSpot('autre')).toBeNull()
  })

  it('une frappe continue n envoie pas une entree par touche : au plus une toutes les 2 s', async () => {
    const ai = await load()
    const e = fakeEditor()
    ai.setAiServer({ token: () => 'jeton', url: p => p })
    ai.setAiEditor(e.context)
    await vi.advanceTimersByTimeAsync(400)
    const before = posted.length
    // 6 s de frappe rapide (une touche toutes les 100 ms, sans pause de 300 ms).
    let at = NOTE.indexOf('écrit.') + 'écrit.'.length
    for (let i = 0; i < 60; i++) { e.type(at++); await vi.advanceTimersByTimeAsync(100) }
    const typing = posted.slice(before)
    expect(typing.length).toBeGreaterThanOrEqual(3)
    expect(typing.length).toBeLessThanOrEqual(4)
    expect(typing.every(p => typeof p.typingAt === 'number')).toBe(true)
    // Les agents de l'appli, eux, savent a la touche pres.
    expect(ai.typingSpot('d1')!.ageMs).toBeLessThanOrEqual(100)
  })

  it('apres 8 s sans frappe, elle ne tape plus ; un curseur deplace ne compte pas pour une frappe', async () => {
    const ai = await load()
    const e = fakeEditor()
    ai.setAiEditor(e.context)
    await vi.advanceTimersByTimeAsync(400)
    e.type(NOTE.indexOf('écrit.') + 'écrit.'.length)
    await vi.advanceTimersByTimeAsync(3000)
    // Elle clique dans un autre paragraphe, sans taper : l'endroit de la frappe reste le sien.
    const typedBlock = splitNoteBlocks(e.text.toString()).find(b => b.text.startsWith('Celui'))!
    e.moveTo(2)
    await vi.advanceTimersByTimeAsync(400)
    const spot = ai.typingSpot('d1')
    expect(spot).toMatchObject({ blockHash: typedBlock.hash })
    expect(spot!.ageMs).toBeGreaterThanOrEqual(3000)
    await vi.advanceTimersByTimeAsync(5000)
    expect(ai.typingSpot('d1')).toBeNull()
  })
})
