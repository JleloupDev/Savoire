// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Pouvoir links : resolution facon Obsidian, retroliens, liens sortants,
// liens non resolus, graphe ; mise a jour quand une note arrive, change de
// nom ou disparait.
import { describe, it, expect } from 'vitest'
import type { VaultIndex } from '@savoire/indexer-core'
import { memoryIndex } from './helpers'

type Items = { items: { id: string; count?: number }[] }
type Outgoing = { resolved: { id: string }[]; unresolved: { target: string }[] }

const back = async (index: VaultIndex, id: string) =>
  ((await index.call('links', 'backlinks', { id })) as Items).items.map(i => [i.id, i.count])
const out = async (index: VaultIndex, id: string) => {
  const r = (await index.call('links', 'outgoing', { id })) as Outgoing
  return { resolved: r.resolved.map(x => x.id), unresolved: r.unresolved.map(x => x.target) }
}

async function vault(): Promise<VaultIndex> {
  const index = await memoryIndex()
  await index.applyDocs([
    { id: 'src', path: 'Projets/Source.md', content: [
      '[[Cible]] et encore [[cible|la cible]]',
      '[[C]] [[Sub/C]] [[deep/sub/c]] [[Plan]] [[Court]] [[Manquante]] [[Source]]',
      '[relatif](../Racine.md) [voisin](Voisin.md) ![[Cible#Partie]]',
    ].join('\n') },
    { id: 'cible', path: 'Notes/Cible.md', content: '# Cible\n' },
    { id: 'c-root', path: 'C.md', content: '' },
    { id: 'c-sub', path: 'Sub/C.md', content: '' },
    { id: 'c-deep', path: 'Deep/Sub/C.md', content: '' },
    { id: 'plan-page', path: 'Plan.page', content: '' },
    { id: 'plan-md', path: 'Plan.md', content: '' },
    { id: 'long', path: 'Notes/Un nom tres long.md', content: '---\naliases: [Court]\n---\n' },
    { id: 'racine', path: 'Racine.md', content: '' },
    { id: 'voisin', path: 'Projets/Voisin.md', content: '' },
    { id: 'voisin-root', path: 'Voisin.md', content: '' },
  ])
  return index
}

describe('resolution des liens', () => {
  it('chemin exact (relatif d abord pour un lien Markdown), nom de fichier (le plus court chemin), .md d abord, alias', async () => {
    const index = await vault()
    expect(await out(index, 'src')).toEqual({
      resolved: ['cible', 'c-root', 'c-sub', 'c-deep', 'plan-md', 'long', 'src', 'racine', 'voisin'],
      unresolved: ['Manquante'],
    })
  })

  it('retroliens : nombre de liens, sans la note elle-meme', async () => {
    const index = await vault()
    expect(await back(index, 'cible')).toEqual([['src', 3]])
    expect(await back(index, 'src')).toEqual([])
    expect(await back(index, 'inconnue')).toEqual([])
  })

  it('une note qui arrive resout les liens qui l attendaient ; une note retiree les libere', async () => {
    const index = await vault()
    await index.applyDoc({ id: 'manq', path: 'Archives/manquante.md', content: '' })
    expect(await back(index, 'manq')).toEqual([['src', 1]])
    expect((await out(index, 'src')).unresolved).toEqual([])
    await index.removeDoc('manq')
    expect((await out(index, 'src')).unresolved).toEqual(['Manquante'])
    // Une note plus proche (chemin plus court) prend la place.
    await index.applyDoc({ id: 'c-new', path: 'Sub2/C.md', content: '' })
    await index.removeDoc('c-root')
    const resolved = (await out(index, 'src')).resolved
    expect(resolved.slice(0, 3)).toEqual(['cible', 'c-sub', 'c-deep'])
    expect(resolved).not.toContain('c-new')
  })

  it('un alias change : les liens suivent', async () => {
    const index = await vault()
    await index.applyDoc({ id: 'long', path: 'Notes/Un nom tres long.md', content: '---\naliases: [Autre]\n---\n' })
    expect((await out(index, 'src')).unresolved).toEqual(['Court', 'Manquante'])
  })

  it('deplacement : le nom change, les liens aussi ; liens relatifs recalcules', async () => {
    const index = await vault()
    expect(await index.moveDoc('cible', 'Archives/Ancienne cible.md')).toBe('moved')
    expect(await back(index, 'cible')).toEqual([])
    expect((await out(index, 'src')).unresolved).toEqual(['Cible', 'Manquante'])
    // La source descend d'un dossier : ../Racine.md vise Projets/Racine.md (absente),
    // puis Racine.md depuis la racine ; Voisin.md vise Projets/Sous/Voisin.md (absente), puis la racine.
    expect(await index.moveDoc('src', 'Projets/Sous/Source.md')).toBe('moved')
    const after = await out(index, 'src')
    expect(after.resolved).toContain('racine')
    expect(after.resolved).toContain('voisin-root')
    // Titre tire du nom : il suit le deplacement.
    await index.moveDoc('c-root', 'Renomme.md')
    const r = await index.queryEngine().query({ from: { notes: true }, where: { field: { doc: 'title' }, op: 'eq', value: 'renomme' } })
    expect(r.rows.map(x => x.id)).toEqual(['c-root'])
    expect((await index.searchEngine().search({ text: 'renomme' })).hits.map(h => h.id)).toEqual(['c-root'])
  })

  it('liens non resolus : cibles, nombre, sources', async () => {
    const index = await vault()
    await index.applyDoc({ id: 'autre', path: 'Autre.md', content: '[[manquante]] [[Fantome]]' })
    const r = (await index.call('links', 'unresolved', {})) as { items: { target: string; count: number; sources: string[] }[] }
    expect(r.items).toEqual([
      { target: 'Manquante', count: 2, sources: ['autre', 'src'] },
      { target: 'Fantome', count: 1, sources: ['autre'] },
    ])
  })

  it('graphe : noeuds, aretes, dossier, limite (les plus relies d abord)', async () => {
    const index = await vault()
    const g = (await index.call('links', 'graph', {})) as { nodes: { id: string }[]; edges: { from: string; to: string }[] }
    expect(g.nodes).toHaveLength(11)
    expect(g.edges).toContainEqual({ from: 'src', to: 'cible' })
    expect(g.edges.some(e => e.from === e.to)).toBe(false)
    const top = (await index.call('links', 'graph', { limit: 2 })) as typeof g
    expect(top.nodes.map(n => n.id)).toEqual(['src', 'cible'])
    expect(top.edges).toEqual([{ from: 'src', to: 'cible' }])
    const notes = (await index.call('links', 'graph', { folder: 'Notes' })) as typeof g
    expect(notes.nodes.map(n => n.id).sort()).toEqual(['cible', 'long'])
    expect(notes.edges).toEqual([])
  })
})
