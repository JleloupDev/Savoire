// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Note rapide (plugin Agenda) : la file du stockage, le texte ajoute a la note
// du jour, et le vidage dans l'ordre.
import { describe, it, expect } from 'vitest'
import {
  appendBlock, captureMarkdown, createCaptureFlusher, readCaptureQueue, removeCaptureEntry,
  QUICK_CAPTURE_KEY, QUICK_CAPTURE_OPEN_KEY, type CaptureEntry, type CaptureEvent,
} from '@savoire/plugin-agenda'

function memoryStore(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init))
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v) },
    removeItem: (k: string) => { m.delete(k) },
    has: (k: string) => m.has(k),
  }
}

const at = (h: number, min: number) => new Date(2026, 10, 25, h, min).getTime()
const entry = (id: string, text: string, h = 9, min = 5): CaptureEntry => ({ id, text, day: '2026-11-25', at: at(h, min) })

describe('note rapide : texte ajoute', () => {
  it('un element de liste qui commence par l\'heure, les lignes suivantes dedans', () => {
    expect(captureMarkdown(entry('a', 'Appeler Hugo'))).toBe('- 09:05 Appeler Hugo')
    expect(captureMarkdown(entry('a', '  Courses\r\nlait\n\npain  ', 14, 32))).toBe('- 14:32 Courses\n  lait\n\n  pain')
  })

  it('a la fin de la note, apres une ligne vide', () => {
    expect(appendBlock('', '- 09:05 A')).toBe('- 09:05 A\n')
    expect(appendBlock('# Jour', '- 09:05 A')).toBe('# Jour\n\n- 09:05 A\n')
    expect(appendBlock('# Jour\n', '- 09:05 A')).toBe('# Jour\n\n- 09:05 A\n')
    expect(appendBlock('# Jour\n\n', '- 09:05 A')).toBe('# Jour\n\n- 09:05 A\n')
  })

  it('a la suite d\'une note rapide precedente, sans casser la liste', () => {
    expect(appendBlock('# Jour\n\n- 09:05 A\n', '- 10:00 B')).toBe('# Jour\n\n- 09:05 A\n- 10:00 B\n')
    expect(appendBlock('# Jour\n\n- 09:05 A\n  suite\n\n', '- 10:00 B')).toBe('# Jour\n\n- 09:05 A\n  suite\n- 10:00 B\n')
    // Une liste ordinaire n'est pas une note rapide : ligne vide.
    expect(appendBlock('- lait\n', '- 10:00 B')).toBe('- lait\n\n- 10:00 B\n')
  })
})

describe('note rapide : file', () => {
  it('lit la file, ignore ce qui est illisible', () => {
    expect(readCaptureQueue(memoryStore())).toEqual([])
    expect(readCaptureQueue(memoryStore({ [QUICK_CAPTURE_KEY]: '{oups' }))).toEqual([])
    const ok = entry('a', 'A')
    expect(readCaptureQueue(memoryStore({ [QUICK_CAPTURE_KEY]: JSON.stringify([ok, { id: 3 }]) }))).toEqual([ok])
  })

  it('retire une note, et la cle quand la file est vide', () => {
    const store = memoryStore({ [QUICK_CAPTURE_KEY]: JSON.stringify([entry('a', 'A'), entry('b', 'B')]) })
    removeCaptureEntry(store, 'a')
    expect(readCaptureQueue(store).map(e => e.id)).toEqual(['b'])
    removeCaptureEntry(store, 'b')
    expect(store.has(QUICK_CAPTURE_KEY)).toBe(false)
  })
})

describe('note rapide : vidage', () => {
  it('ecrit chaque note dans l\'ordre, puis la retire et le dit', async () => {
    const store = memoryStore({ [QUICK_CAPTURE_KEY]: JSON.stringify([entry('a', 'A'), entry('b', 'B', 9, 6)]) })
    const written: string[] = []
    const events: CaptureEvent[] = []
    const f = createCaptureFlusher({
      store,
      append: async (day, md) => { written.push(`${day} ${md}`); return `Journal/${day}.md` },
      openToday: async () => {},
      emit: e => events.push(e),
    })
    await f.flush()
    expect(written).toEqual(['2026-11-25 - 09:05 A', '2026-11-25 - 09:06 B'])
    expect(readCaptureQueue(store)).toEqual([])
    expect(events).toEqual([
      { type: 'done', id: 'a', path: 'Journal/2026-11-25.md' },
      { type: 'done', id: 'b', path: 'Journal/2026-11-25.md' },
    ])
  })

  it('une erreur garde la note et les suivantes ; le tour suivant reprend', async () => {
    const store = memoryStore({ [QUICK_CAPTURE_KEY]: JSON.stringify([entry('a', 'A'), entry('b', 'B')]) })
    let fail = true
    const events: CaptureEvent[] = []
    const f = createCaptureFlusher({
      store,
      append: async () => { if (fail) throw new Error('Hors ligne.'); return 'J.md' },
      openToday: async () => {},
      emit: e => events.push(e),
    })
    await f.flush()
    expect(events).toEqual([{ type: 'error', id: 'a', message: 'Hors ligne.' }])
    expect(readCaptureQueue(store).map(e => e.id)).toEqual(['a', 'b'])
    fail = false
    await f.flush()
    expect(readCaptureQueue(store)).toEqual([])
  })

  it('une note ajoutee pendant le vidage part dans le meme elan', async () => {
    const store = memoryStore({ [QUICK_CAPTURE_KEY]: JSON.stringify([entry('a', 'A')]) })
    const written: string[] = []
    let f!: ReturnType<typeof createCaptureFlusher>
    f = createCaptureFlusher({
      store,
      append: async (_day, md) => {
        written.push(md)
        if (md.endsWith(' A')) {
          // L'ecran ajoute une note pendant l'ecriture de la premiere.
          store.setItem(QUICK_CAPTURE_KEY, JSON.stringify([...readCaptureQueue(store), entry('b', 'B')]))
          f.handle({ type: 'queued' })
        }
        return 'J.md'
      },
      openToday: async () => {},
      emit: () => {},
    })
    await f.flush()
    expect(written).toEqual(['- 09:05 A', '- 09:05 B'])
    expect(readCaptureQueue(store)).toEqual([])
  })

  it('ouvre la note du jour quand l\'ecran l\'a demande, une fois', async () => {
    const store = memoryStore({ [QUICK_CAPTURE_OPEN_KEY]: '1' })
    let opened = 0
    const f = createCaptureFlusher({ store, append: async () => 'J.md', openToday: async () => { opened++ }, emit: () => {} })
    await f.flush()
    await f.flush()
    expect(opened).toBe(1)
    expect(store.has(QUICK_CAPTURE_OPEN_KEY)).toBe(false)
  })
})
