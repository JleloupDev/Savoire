// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Pouvoir blocks : blocs d'une note, bloc retrouve par son empreinte,
// passages partages entre notes.
import { describe, it, expect } from 'vitest'
import { splitNoteBlocks } from '@savoire/plugin-api'
import { memoryIndex } from './helpers'

const LONG = 'Un passage assez long pour compter comme partagé entre deux notes.'

async function vault() {
  const index = await memoryIndex()
  await index.applyDocs([
    { id: 'a', path: 'A.md', content: `---\ntags: [x]\n---\n# Titre\n\n${LONG}\n\nCourt.\n\n- un\n- deux ^item\n` },
    { id: 'b', path: 'Dossier/B.md', content: `Intro.\n\n${LONG}\n\nCourt.\n` },
    { id: 't', path: '.trash/T.md', content: `${LONG}\n` },
  ])
  return index
}

type Items<T> = { items: T[] }

describe('blocks', () => {
  it('liste les blocs d une note, sans le frontmatter', async () => {
    const index = await vault()
    const r = await index.call('blocks', 'list', { id: 'a' }) as { id: string; path: string } & Items<{ kind: string; section?: string; blockId?: string; from: number; preview: string }>
    expect(r.path).toBe('A.md')
    expect(r.items.map(i => i.kind)).toEqual(['heading', 'paragraph', 'paragraph', 'list'])
    expect(r.items[1].section).toBe('Titre')
    expect(r.items[3].blockId).toBe('item')
    expect(await index.call('blocks', 'list', { id: 'inconnu' })).toEqual({ id: 'inconnu', path: '', items: [] })
  })

  it('retrouve un bloc par son empreinte, hors corbeille', async () => {
    const index = await vault()
    const hash = splitNoteBlocks(LONG)[0].hash
    const r = await index.call('blocks', 'find', { hash }) as Items<{ id: string }>
    expect(r.items.map(i => i.id)).toEqual(['a', 'b'])
    await expect(index.call('blocks', 'find', { hash: 'pas-un-hash' })).rejects.toMatchObject({ code: 'invalid_query' })
  })

  it('passages partages : assez longs, dans une autre note', async () => {
    const index = await vault()
    const r = await index.call('blocks', 'shared', { id: 'a' }) as Items<{ index: number; others: { id: string; path: string }[] }>
    expect(r.items).toEqual([{ index: 2, hash: splitNoteBlocks(LONG)[0].hash, others: [{ id: 'b', path: 'Dossier/B.md', title: 'B' }] }])
  })
})
