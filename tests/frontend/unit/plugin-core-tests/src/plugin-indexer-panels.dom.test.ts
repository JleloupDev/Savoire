// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Panneaux branches sur le pair indexeur : recherche (api.search, recherche
// globale), retroliens (links.backlinks), graphe (links.graph), hashtags
// (tags.*) ; avec et sans pouvoirs, et pouvoirs qui tombent.
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, type ReactElement } from 'react'
import type {
  IIndexerAPI, IndexState, ISearchEngine, SearchQuery, SearchResult, ViewContext,
} from '@savoire/plugin-api'
import { SearchWidget, describeSearchState } from '@savoire/plugin-search'
import { WikilinkIndexContributor } from '@savoire/plugin-wikilinks'
import { BacklinksWidget } from '@savoire/plugin-backlinks'
import { GraphWidget, GraphIndexContributor } from '@savoire/plugin-graph'
import { HashtagsWidget, HashtagIndexContributor } from '@savoire/plugin-hashtags'

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

const roots: Root[] = []
afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount())
  document.body.innerHTML = ''
})

async function mount(el: unknown): Promise<HTMLElement> {
  const div = document.createElement('div')
  document.body.appendChild(div)
  const root = createRoot(div)
  roots.push(root)
  await act(async () => { root.render(el as ReactElement) })
  return div
}

const wait = (ms: number) => act(() => new Promise<void>(r => setTimeout(r, ms)))

function makeCtx(activePath: string | null, files: Record<string, string> = {}) {
  const openFile = vi.fn(async () => {})
  const ctx = {
    workspace: {
      openFile,
      openPanel: () => {},
      closePanel: () => {},
      getActiveDocument: () => (activePath ? { path: activePath, content: '' } : undefined),
      subscribeActiveDocument: () => () => {},
      subscribeVaultChange: () => () => {},
      subscribeDocumentIndexed: () => () => {},
    },
    vault: {
      resolveDocumentId: (p: string) => files[p],
      isTrashed: () => false,
      list: async () => Object.keys(files),
    },
    fileTypes: {},
  } as unknown as ViewContext
  return { ctx, openFile }
}

function fakeIndexer(over: Partial<IIndexerAPI> & { up?: boolean } = {}): IIndexerAPI {
  const up = over.up ?? true
  return {
    available: () => up,
    state: () => ({ status: up ? 'ready' : 'unavailable' }),
    onStateChange: () => () => {},
    links: {
      backlinks: vi.fn(async () => ({ items: [] })),
      outgoing: vi.fn(async () => ({ resolved: [], unresolved: [] })),
      unresolved: vi.fn(async () => ({ items: [] })),
      graph: vi.fn(async () => ({ nodes: [], edges: [] })),
    },
    tags: { list: vi.fn(async () => ({ items: [] })), notes: vi.fn(async () => ({ items: [] })) },
    status: vi.fn(async () => ({ status: 'ready' as const })),
    ...over,
  } as IIndexerAPI
}

// ── Recherche ──────────────────────────────────────────────────────────────

function page(ids: string[], next?: string, extra: Partial<SearchResult> = {}): SearchResult {
  return {
    hits: ids.map(id => ({
      id, path: `Energie/${id}.md`, title: `Réseau ${id}`, score: 1,
      titleHighlights: [{ start: 0, end: 6 }],
      snippets: [{ text: 'Les travaux sur le réseau commencent.', highlights: [{ start: 19, end: 25 }], heading: 'Travaux' }],
    })),
    total: 3,
    index: { status: 'ready' },
    ...(next ? { next } : {}),
    ...extra,
  }
}

function fakeSearch(state: IndexState = { status: 'ready' }) {
  const search = vi.fn(async (q: SearchQuery) => (q.cursor ? page(['c']) : page(['a', 'b'], 'p2')))
  const engine: ISearchEngine = { search, state: () => state, onStateChange: () => () => {} }
  return { engine, search }
}

describe('panneau de recherche (api.search)', () => {
  it('titre et extraits surlignes, section, chemin ; page suivante au defilement ; clic ouvre la note', async () => {
    const { engine, search } = fakeSearch()
    const { ctx, openFile } = makeCtx(null)
    const div = await mount(new SearchWidget(ctx, engine).render())
    const input = div.querySelector('[data-testid="search-input"]') as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'réseau')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await wait(300)
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ text: 'réseau', limit: 30 }), expect.anything())
    const hits = div.querySelectorAll('[data-testid="search-hit"]')
    expect(hits.length).toBe(2)
    expect(hits[0].querySelector('[data-testid="search-hit-title"] mark')!.textContent).toBe('Réseau')
    const snippet = hits[0].querySelector('[data-testid="search-snippet"]')!
    expect(snippet.textContent).toContain('§ Travaux')
    expect(snippet.querySelector('mark')!.textContent).toBe('réseau')
    expect(hits[0].textContent).toContain('Energie')
    expect(div.querySelector('[data-testid="search-count"]')!.textContent).toBe('3 résultats')
    // Defilement en bas : la page suivante, avec le curseur.
    await act(async () => { div.querySelector('[data-testid="search-results"]')!.dispatchEvent(new Event('scroll')) })
    await wait(10)
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'p2' }), expect.anything())
    expect(div.querySelectorAll('[data-testid="search-hit"]').length).toBe(3)
    await act(async () => { (div.querySelectorAll('[data-testid="search-hit"]')[2] as HTMLElement).click() })
    expect(openFile).toHaveBeenCalledWith('Energie/c.md')
  })

  it('etat de l index affiche ; pas d option « Tous mes vaults » sans recherche globale', async () => {
    const { engine } = fakeSearch({ status: 'building', progress: 0.63 })
    const { ctx } = makeCtx(null)
    const div = await mount(new SearchWidget(ctx, engine).render())
    expect(div.querySelector('[data-testid="search-state"]')!.textContent).toContain('63 %')
    expect(div.querySelector('[data-testid="search-all-vaults"]')).toBeNull()
    expect(describeSearchState({ status: 'unavailable' })).toContain('notes ouvertes')
    expect(describeSearchState({ status: 'ready' })).toBeNull()
  })

  it('Tous mes vaults : groupes par vault, resultats partiels signales, clic ouvre le vault et la note', async () => {
    const { engine } = fakeSearch()
    const globalSearch = vi.fn(async () => ({
      hits: [
        { id: 'n1', path: 'A.md', title: 'A', score: 3, snippets: [], vaultId: 'v1', vaultName: 'Perso' },
        { id: 'n2', path: 'B.md', title: 'B', score: 2, snippets: [], vaultId: 'v2', vaultName: 'Travail' },
        { id: 'n3', path: 'C.md', title: 'C', score: 1, snippets: [], vaultId: 'v1', vaultName: 'Perso' },
      ],
      total: 3, index: { status: 'ready' as const }, partial: true,
    }))
    const open = vi.fn(async () => {})
    const withGlobal: ISearchEngine = { ...engine, global: { search: globalSearch, open } }
    const { ctx } = makeCtx(null)
    const div = await mount(new SearchWidget(ctx, withGlobal, { wantGlobal: true }).render())
    expect((div.querySelector('[data-testid="search-all-vaults"]') as HTMLInputElement).checked).toBe(true)
    const input = div.querySelector('[data-testid="search-input"]') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'x')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await wait(300)
    expect(globalSearch).toHaveBeenCalled()
    const groups = [...div.querySelectorAll('[data-testid="search-vault-group"]')]
    expect(groups.map(g => g.getAttribute('data-vault'))).toEqual(['v1', 'v2'])
    expect(groups[0].textContent).toContain('Perso')
    expect(groups[0].querySelectorAll('[data-testid="search-hit"]').length).toBe(2)
    expect(div.querySelector('[data-testid="search-partial"]')).not.toBeNull()
    await act(async () => { (groups[1].querySelector('[data-testid="search-hit"]') as HTMLElement).click() })
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: 'n2', vaultId: 'v2' }))
  })
})

// ── Retroliens ─────────────────────────────────────────────────────────────

describe('retroliens (links.backlinks)', () => {
  const local = () => {
    const c = new WikilinkIndexContributor()
    c.onEntriesChanged(new Map([['o', [{ key: 'targets', value: { path: 'Ouverte.md', targets: ['Cible'] } }]]]))
    return c
  }

  it('avec un index complet : les notes jamais ouvertes comptent aussi', async () => {
    const indexer = fakeIndexer({})
    ;(indexer.links.backlinks as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [
      { id: 'o', path: 'Ouverte.md', title: 'Ouverte', count: 1 },
      { id: 'j', path: 'Jamais ouverte.md', title: 'Jamais ouverte', count: 2 },
    ] })
    const { ctx } = makeCtx('Cible.md', { 'Cible.md': 'cible' })
    const div = await mount(new BacklinksWidget(ctx, local(), indexer).render())
    await wait(10)
    expect(indexer.links.backlinks).toHaveBeenCalledWith({ id: 'cible' })
    expect([...div.querySelectorAll('[data-testid="backlink"]')].map(e => e.textContent)).toEqual(['Ouverte.mdwikilink', 'Jamais ouverte.mdwikilink ×2'])
    expect(div.querySelector('[data-testid="backlinks-source"]')!.getAttribute('data-whole')).toBe('true')
  })

  it('sans pouvoirs, ou pair qui refuse : l index partage, comme avant', async () => {
    const { ctx } = makeCtx('Cible.md', { 'Cible.md': 'cible' })
    const div = await mount(new BacklinksWidget(ctx, local()).render())
    expect([...div.querySelectorAll('[data-testid="backlink"]')].map(e => e.textContent)).toEqual(['Ouverte.mdwikilink'])
    const failing = fakeIndexer({})
    ;(failing.links.backlinks as ReturnType<typeof vi.fn>).mockRejectedValue(Object.assign(new Error('x'), { code: 'unavailable' }))
    const div2 = await mount(new BacklinksWidget(ctx, local(), failing).render())
    await wait(10)
    expect([...div2.querySelectorAll('[data-testid="backlink"]')].map(e => e.textContent)).toEqual(['Ouverte.mdwikilink'])
    expect(div2.querySelector('[data-testid="backlinks-source"]')!.getAttribute('data-whole')).toBe('false')
    // Index indisponible : pas d'appel du tout.
    const down = fakeIndexer({ up: false })
    await mount(new BacklinksWidget(ctx, local(), down).render())
    expect(down.links.backlinks).not.toHaveBeenCalled()
  })
})

// ── Graphe ─────────────────────────────────────────────────────────────────

describe('graphe (links.graph)', () => {
  const header = (div: HTMLElement) => div.textContent ?? ''

  it('avec un index complet : toutes les notes et leurs liens, d un seul appel', async () => {
    const indexer = fakeIndexer({})
    ;(indexer.links.graph as ReturnType<typeof vi.fn>).mockResolvedValue({
      nodes: [{ id: 'a', path: 'A.md', title: 'A' }, { id: 'b', path: 'B.md', title: 'B' }, { id: 'c', path: 'C.md', title: 'C' }],
      edges: [{ from: 'a', to: 'b' }, { from: 'c', to: 'b' }],
    })
    const { ctx } = makeCtx(null, { 'A.md': 'a' })
    const div = await mount(new GraphWidget(ctx, () => new GraphIndexContributor(), indexer).render())
    await wait(20)
    expect(indexer.links.graph).toHaveBeenCalledWith({ limit: 2000 })
    expect(header(div)).toContain('3 notes · 2 liens')
    expect(div.querySelector('[data-testid="graph-source"]')!.getAttribute('data-whole')).toBe('true')
  })

  it('sans pouvoirs : les notes du vault et les liens indexes, comme avant', async () => {
    const contributor = new GraphIndexContributor()
    contributor.onEntriesChanged(new Map([['a', [{ key: 'links', value: { path: 'A.md', targets: [{ targetPath: 'B', linkType: 'wikilink' }] } }]]]))
    const { ctx } = makeCtx(null, { 'A.md': 'a', 'B.md': 'b' })
    const div = await mount(new GraphWidget(ctx, () => contributor, fakeIndexer({ up: false })).render())
    await wait(20)
    expect(header(div)).toContain('2 notes · 1 liens')
    expect(div.querySelector('[data-testid="graph-source"]')!.getAttribute('data-whole')).toBe('false')
  })
})

// ── Hashtags ───────────────────────────────────────────────────────────────

describe('hashtags (tags.list, tags.notes)', () => {
  it('avec un index complet : tags du vault, notes d un tag ouvertes ou non', async () => {
    const indexer = fakeIndexer({})
    ;(indexer.tags.list as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [{ tag: 'projet', count: 4 }] })
    ;(indexer.tags.notes as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [{ id: 'j', path: 'Jamais ouverte.md', title: 'J' }] })
    const { ctx } = makeCtx(null)
    const div = await mount(new HashtagsWidget(ctx, () => new HashtagIndexContributor(), indexer).render())
    await wait(10)
    const tag = div.querySelector('[data-testid="vault-tags"] span') as HTMLElement
    expect(tag.textContent).toContain('#projet')
    await act(async () => { tag.click() })
    await wait(10)
    expect(indexer.tags.notes).toHaveBeenCalledWith({ tag: 'projet' })
    expect(div.textContent).toContain('Jamais ouverte.md')
  })

  it('sans pouvoirs : pas de tags du vault ; les tags de la note viennent de l index partage', async () => {
    const contributor = new HashtagIndexContributor()
    contributor.onEntriesChanged(new Map([['n', [{ key: 'tags', value: { path: 'N.md', tags: ['idee'] } }]]]))
    const { ctx } = makeCtx('N.md', { 'N.md': 'n' })
    const div = await mount(new HashtagsWidget(ctx, () => contributor).render())
    expect(div.querySelector('[data-testid="vault-tags"]')).toBeNull()
    expect(div.textContent).toContain('#idee')
  })
})
