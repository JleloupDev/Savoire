// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Blocs de la note ouverte (apps/web/src/liveBlocks.ts) et « modifié depuis
// votre dernière visite » (visitMarks.ts) ; lien vers un bloc (blockLinks.ts).
import { describe, it, expect, beforeAll } from 'vitest'
import type { HookRegistry } from '@savoire/plugin-api'
import { liveBlocks } from '../../../../../apps/web/src/liveBlocks'
import { changedBlocks, loadSeen, saveSeen, startVisitMarks } from '../../../../../apps/web/src/visitMarks'
import { addBlockId } from '../../../../../apps/web/src/blockLinks'
import { splitNoteBlocks } from '@savoire/plugin-api'

type Stable = (docId: string, path: string, content: string, v?: unknown, info?: { local: boolean }) => void
let stable: Stable = () => {}
const hooks = { onDocumentStabilized: (cb: Stable) => { stable = cb } } as unknown as HookRegistry

function fakeEditor(docId: string, text: string) {
  const e = {
    text, docId,
    marks: new Map<string, { from: number; to: number; className: string }[]>(),
    exportMarkdown: () => e.text,
    on: () => () => {},
    setBlockMarks: (owner: string, m: { from: number; to: number; className: string }[]) => { e.marks.set(owner, m) },
    getDocId: () => e.docId,
    getActiveFile: () => 'Note.md',
  }
  return e
}

function open(e: ReturnType<typeof fakeEditor>) {
  liveBlocks.setEditor({ editor: e as never, docId: () => e.docId, path: () => 'Note.md', vaultId: () => 'v1' })
}

const changedText = (e: ReturnType<typeof fakeEditor>) =>
  (e.marks.get('visit') ?? []).map(m => e.text.slice(m.from, m.to))

beforeAll(() => {
  liveBlocks.attachHooks(hooks)
  startVisitMarks()
})

describe('derniere visite', () => {
  it('premiere visite : rien ; un pair change un bloc : il prend le trait ; ce que j ecris : non', () => {
    const e = fakeEditor('d1', 'Un.\n\nDeux.')
    open(e)
    expect(changedText(e)).toEqual([])
    // Un pair modifie « Deux ».
    e.text = 'Un.\n\nDeux, change par un pair.'
    stable('d1', 'Note.md', e.text, undefined, { local: false })
    expect(changedText(e)).toEqual(['Deux, change par un pair.'])
    // J'ecris dans « Un » : vu ; le bloc du pair garde son trait.
    e.text = 'Un, et moi.\n\nDeux, change par un pair.'
    stable('d1', 'Note.md', e.text, undefined, { local: true })
    expect(changedText(e)).toEqual(['Deux, change par un pair.'])
  })

  it('en quittant la note, tout compte comme vu ; au retour, seul ce qui a change depuis', () => {
    const a = fakeEditor('d2', 'Alpha.\n\nBeta.')
    open(a)
    const other = fakeEditor('d3', 'Autre.')
    open(other)
    expect([...loadSeen('v1', 'd2')!].length).toBe(2)
    // Pendant l'absence, Beta change.
    const back = fakeEditor('d2', 'Alpha.\n\nBeta modifie.')
    open(back)
    expect(changedText(back)).toEqual(['Beta modifie.'])
  })

  it('empreintes vues, et ce qui a change', () => {
    saveSeen('v1', 'x', ['a', 'b'])
    expect(loadSeen('v1', 'x')).toEqual(new Set(['a', 'b']))
    const blocks = splitNoteBlocks('# T\n\nVu.\n\nNouveau.')
    const seen = new Set([blocks[0].hash, blocks[1].hash])
    expect(changedBlocks(blocks, seen).map(b => b.text)).toEqual(['Nouveau.'])
  })
})

describe('lien vers un bloc', () => {
  it('donne un identifiant au bloc, seulement s il est toujours la', () => {
    const text = 'Un.\n\nDeux.'
    const hash = splitNoteBlocks(text)[1].hash
    expect(addBlockId(text, hash, 'abc')).toBe('Un.\n\nDeux. ^abc')
    expect(addBlockId('Un.\n\nAutre.', hash, 'abc')).toBe('Un.\n\nAutre.')
  })
})
