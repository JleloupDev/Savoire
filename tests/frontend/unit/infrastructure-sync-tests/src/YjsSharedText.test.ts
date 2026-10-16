// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Adaptateur Yjs -> ISharedText : deltas sans attributs, origine local/remote.
import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import type { ChangeOrigin, TextDelta } from '@savoire/plugin-api'
import { YjsSharedText, fromYjsDelta } from '@savoire/infrastructure-sync'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Y_ = Y as Record<string, any>

function makeText(): { doc: Y.Doc; ytext: Y.Text; text: YjsSharedText; seen: { delta: TextDelta; origin: ChangeOrigin }[] } {
  const doc = new Y_.Doc() as Y.Doc
  const ytext = doc.getText('codemirror')
  const text = new YjsSharedText(ytext)
  const seen: { delta: TextDelta; origin: ChangeOrigin }[] = []
  text.onChange((delta, origin) => { seen.push({ delta, origin }) })
  return { doc, ytext, text, seen }
}

describe('YjsSharedText', () => {
  it('insert et delete emettent des deltas locaux', () => {
    const { text, seen } = makeText()
    text.insert(0, 'bonjour')
    text.delete(3, 4)
    expect(text.toString()).toBe('bon')
    expect(text.length).toBe(3)
    expect(seen).toEqual([
      { delta: [{ insert: 'bonjour' }], origin: 'local' },
      { delta: [{ retain: 3 }, { delete: 4 }], origin: 'local' },
    ])
  })

  it('applyDelta fait une seule modification', () => {
    const { text, seen } = makeText()
    text.insert(0, 'abcdef')
    seen.length = 0
    text.applyDelta([{ retain: 1 }, { delete: 2 }, { insert: 'XY' }, { retain: 1 }, { insert: 'Z' }])
    expect(text.toString()).toBe('aXYdZef')
    expect(seen).toHaveLength(1)
    expect(seen[0].origin).toBe('local')
  })

  it('garde un saut de ligne final', () => {
    const { text } = makeText()
    text.applyDelta([{ insert: 'ligne\n' }])
    expect(text.toString()).toBe('ligne\n')
  })

  it('une mise a jour venue d\'un autre doc arrive en distant', () => {
    const { doc, text, seen } = makeText()
    const other = new Y_.Doc() as Y.Doc
    other.getText('codemirror').insert(0, 'salut')
    Y_.applyUpdate(doc, Y_.encodeStateAsUpdate(other), 'remote')
    expect(text.toString()).toBe('salut')
    expect(seen).toEqual([{ delta: [{ insert: 'salut' }], origin: 'remote' }])
  })

  it('ignore les attributs de format', () => {
    const { ytext, seen } = makeText()
    ;(ytext as unknown as { insert(i: number, t: string, a: object): void }).insert(0, 'gras', { bold: true })
    expect(seen).toEqual([{ delta: [{ insert: 'gras' }], origin: 'local' }])
    expect(fromYjsDelta([{ retain: 2, attributes: { bold: null } } as never, { insert: { image: 'x' } }])).toEqual([{ retain: 2 }])
  })

  it('dispose coupe les abonnes', () => {
    const { ytext, text, seen } = makeText()
    text.dispose()
    ytext.insert(0, 'x')
    expect(seen).toEqual([])
  })
})
