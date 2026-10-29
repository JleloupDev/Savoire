// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Pouvoir tags : liste des tags (frontmatter et texte, hors code) et notes
// d'un tag, casse ignoree, tags imbriques.
import { describe, it, expect } from 'vitest'
import { memoryIndex } from './helpers'

async function vault() {
  const index = await memoryIndex()
  await index.applyDocs([
    { id: 'a', path: 'A.md', content: '---\ntags: [projet, client]\n---\nTexte #Projet #projet/alpha `#code`\n' },
    { id: 'b', path: 'B.md', content: '#projet/beta et #client\n' },
    { id: 'c', path: 'C.md', content: '#autre\n```\n#dans-le-code\n```\n' },
    { id: 't', path: '.trash/T.md', content: '#projet\n' },
  ])
  return index
}

describe('tags', () => {
  it('liste : notes par tag, les plus courants d abord, casse ignoree, hors code et corbeille', async () => {
    const index = await vault()
    expect(await index.call('tags', 'list', {})).toEqual({ items: [
      { tag: 'client', count: 2 },
      { tag: 'autre', count: 1 },
      { tag: 'projet', count: 1 },
      { tag: 'projet/alpha', count: 1 },
      { tag: 'projet/beta', count: 1 },
    ] })
    expect(await index.call('tags', 'list', { prefix: '#Projet', limit: 2 })).toEqual({ items: [
      { tag: 'projet', count: 1 },
      { tag: 'projet/alpha', count: 1 },
    ] })
  })

  it('notes d un tag, sous-tags compris', async () => {
    const index = await vault()
    const ids = async (tag: string) => ((await index.call('tags', 'notes', { tag })) as { items: { id: string }[] }).items.map(i => i.id)
    expect(await ids('projet')).toEqual(['a', 'b'])
    expect(await ids('#PROJET/beta')).toEqual(['b'])
    expect(await ids('proj')).toEqual([])
  })

  it('une note modifiee ou retiree met la liste a jour', async () => {
    const index = await vault()
    await index.applyDoc({ id: 'b', path: 'B.md', content: 'plus de tag\n' })
    await index.removeDoc('c')
    expect(await index.call('tags', 'list', {})).toEqual({ items: [
      { tag: 'client', count: 1 },
      { tag: 'projet', count: 1 },
      { tag: 'projet/alpha', count: 1 },
    ] })
  })
})
