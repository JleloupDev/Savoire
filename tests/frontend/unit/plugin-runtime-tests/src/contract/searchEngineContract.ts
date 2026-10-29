// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Contrat commun de ISearchEngine. Tout moteur de recherche (SQLite du pair
// indexeur, du bureau, du navigateur ; un moteur en memoire un jour) doit le
// passer : il fixe ce que le panneau de recherche peut attendre. Voir
// ADR-027 et search.ts.
//
// Les notes sont donnees en Markdown, telles qu'elles sont dans le vault :
// chaque moteur les lit avec sa propre extraction (titre, texte, sections,
// proprietes).
import { describe, it, expect } from 'vitest'
import type { ISearchEngine, SearchHit, SearchQuery, SearchResult } from '@savoire/plugin-api'

export interface SearchNote {
  id: string
  path: string
  content: string
}

export interface SearchEngineHarness {
  /** Un moteur qui contient exactement ces notes. */
  open(notes: SearchNote[]): Promise<{
    engine: ISearchEngine
    upsert(note: SearchNote): Promise<void>
    remove(id: string): Promise<void>
  }>
}

const section = (i: number) =>
  `## Partie ${i}\n\nUn long paragraphe de remplissage pour eloigner les passages les uns des autres, `
  + `avec assez de mots pour depasser la taille d un extrait ordinaire. La lave coule ici, numero ${i}. `
  + 'Encore quelques phrases sans interet particulier, puis la suite du texte continue tranquillement.\n'

/** Petit vault de reference. */
export const SEARCH_SAMPLE: SearchNote[] = [
  { id: 'n1', path: 'Energie/Reseau.md', content: '# Le réseau électrique\n\nLe réseau de la ville est ancien.\n\n## Travaux\n\nLes travaux sur le réseau commencent en mars.\n' },
  { id: 'n2', path: 'Energie/Centrale.md', content: '---\nstatut: Actif\ntype: Rapport annuel\n---\n# Centrale\n\nProduction d\'électricité, sans travaux.\n' },
  { id: 'n3', path: 'Notes/Courses.md', content: 'Acheter du pain et du lait.\n' },
  { id: 'n4', path: 'Notes/Plan.outline', content: '- Réseau\n  - travaux de mars\n' },
  { id: 'n5', path: 'Geologie/Volcan.md', content: '# Volcan\n\nUne montagne.\n' },
  { id: 'n6', path: 'Geologie/Roches.md', content: 'Le basalte vient d\'un volcan éteint, loin du sommet de la montagne, et de bien d\'autres choses encore.\n' },
  { id: 'n7', path: 'Geologie/Lave.md', content: [1, 2, 3, 4, 5, 6].map(section).join('\n') },
  { id: 'd2', path: 'Doublons/a.md', content: '# Jumeau\n\nTexte identique.\n' },
  { id: 'd1', path: 'Doublons/b.md', content: '# Jumeau\n\nTexte identique.\n' },
  { id: 't1', path: '.trash/Ancien.md', content: 'Réseau électrique supprimé.\n' },
]

const ids = (r: SearchResult) => r.hits.map(h => h.id)
const sorted = (r: SearchResult) => ids(r).sort()
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/** Chaque surlignage tombe sur un mot cherche. */
function expectHighlights(hit: SearchHit, terms: string[]): void {
  for (const s of hit.snippets) {
    expect(s.highlights.length).toBeGreaterThan(0)
    for (const h of s.highlights) {
      expect(h.start).toBeGreaterThanOrEqual(0)
      expect(h.end).toBeLessThanOrEqual(s.text.length)
      const found = fold(s.text.slice(h.start, h.end))
      expect(terms.some(t => found.startsWith(t))).toBe(true)
    }
  }
  for (const h of hit.titleHighlights ?? []) {
    expect(terms.some(t => fold(hit.title.slice(h.start, h.end)).startsWith(t))).toBe(true)
  }
}

export function describeSearchEngineContract(name: string, harness: SearchEngineHarness): void {
  describe(`contrat ISearchEngine — ${name}`, () => {
    const open = () => harness.open(SEARCH_SAMPLE)
    const run = async (q: SearchQuery) => (await open()).engine.search(q)

    describe('mots', () => {
      it('texte vide ou sans mot : aucun resultat', async () => {
        const { engine } = await open()
        expect(await engine.search({ text: '' })).toMatchObject({ hits: [], total: 0 })
        expect(await engine.search({ text: '  !!! ' })).toMatchObject({ hits: [], total: 0 })
      })

      it('tous les mots, debuts de mots, sans casse ni accents', async () => {
        const { engine } = await open()
        expect(sorted(await engine.search({ text: 'RESEAU electri' }))).toEqual(['n1'])
        expect(sorted(await engine.search({ text: 'reseau' }))).toEqual(['n1', 'n4'])
        expect(sorted(await engine.search({ text: 'travaux mars' }))).toEqual(['n1', 'n4'])
        expect(sorted(await engine.search({ text: 'volc' }))).toEqual(['n5', 'n6'])
      })

      it('titre, texte et proprietes texte', async () => {
        expect(ids(await run({ text: 'rapport annuel' }))).toEqual(['n2'])
        expect(ids(await run({ text: 'centrale' }))).toEqual(['n2'])
        expect(ids(await run({ text: 'pain lait' }))).toEqual(['n3'])
      })

      it('entre guillemets : la suite de mots exacte', async () => {
        const { engine } = await open()
        expect(ids(await engine.search({ text: '"réseau de la ville"' }))).toEqual(['n1'])
        expect((await engine.search({ text: '"ville réseau"' })).total).toBe(0)
        expect(ids(await engine.search({ text: '"travaux de mars"' }))).toEqual(['n4'])
        // Un mot entre guillemets est un mot entier, pas un debut.
        expect((await engine.search({ text: '"electri"' })).total).toBe(0)
        expect(ids(await engine.search({ text: 'ville "le réseau"' }))).toEqual(['n1'])
      })

      it('la corbeille n est jamais cherchee', async () => {
        expect((await run({ text: 'supprime' })).total).toBe(0)
      })

      it('la syntaxe tapee n est jamais interpretee', async () => {
        const { engine } = await open()
        for (const text of ['reseau OR volcan', 'reseau AND NOT volcan', 'title:volcan', '(reseau', 'NEAR(reseau volcan)',
          '"', '-reseau', '^reseau', '{title}: reseau', 'volc*', "re'seau", 'reseau"', '***', 'a:b:c']) {
          await expect(engine.search({ text })).resolves.toHaveProperty('hits')
        }
        // OR est un mot comme un autre : aucune note n'a les trois.
        expect((await engine.search({ text: 'reseau OR volcan' })).total).toBe(0)
        expect(sorted(await engine.search({ text: 'volc*' }))).toEqual(['n5', 'n6'])
      })
    })

    describe('ordre et pagination', () => {
      it('un mot du titre compte plus qu un mot du texte', async () => {
        const r = await run({ text: 'volcan' })
        expect(ids(r)).toEqual(['n5', 'n6'])
        expect(r.hits[0].score).toBeGreaterThan(r.hits[1].score)
      })

      it('a pertinence egale, l ordre de l id', async () => {
        expect(ids(await run({ text: 'jumeau' }))).toEqual(['d1', 'd2'])
      })

      it('les pages couvrent tout le resultat, une fois, dans l ordre', async () => {
        const { engine } = await open()
        const whole = await engine.search({ text: 'e', limit: 50 })
        expect(whole.total).toBeGreaterThan(4)
        const seen: string[] = []
        let r = await engine.search({ text: 'e', limit: 2 })
        seen.push(...ids(r))
        while (r.next) {
          r = await engine.search({ text: 'e', limit: 2, cursor: r.next })
          seen.push(...ids(r))
        }
        expect(seen).toEqual(ids(whole))
        expect(r.total).toBe(whole.total)
      })

      it('un curseur ne vaut que pour sa recherche ; limit borne', async () => {
        const { engine } = await open()
        const first = await engine.search({ text: 'e', limit: 1 })
        expect(first.next).toBeTruthy()
        await expect(engine.search({ text: 'reseau', cursor: first.next })).rejects.toMatchObject({ code: 'invalid_cursor' })
        await expect(engine.search({ text: 'e', cursor: 'n importe quoi' })).rejects.toMatchObject({ code: 'invalid_cursor' })
        await expect(engine.search({ text: 'e', limit: 0 })).rejects.toMatchObject({ code: 'invalid_query' })
        await expect(engine.search({ text: 'e', limit: 501 })).rejects.toMatchObject({ code: 'invalid_query' })
      })
    })

    describe('extraits', () => {
      it('autour des mots trouves, avec le titre de section le plus proche', async () => {
        const r = await run({ text: 'travaux', folder: 'Energie' })
        expect(sorted(r)).toEqual(['n1', 'n2'])
        const n1 = r.hits.find(h => h.id === 'n1')!
        expect(n1.snippets.length).toBeGreaterThan(0)
        expect(n1.snippets.some(s => s.heading === 'Travaux' && fold(s.text).includes('les travaux sur le reseau'))).toBe(true)
        for (const hit of r.hits) expectHighlights(hit, ['travaux'])
        const n2 = r.hits.find(h => h.id === 'n2')!
        expect(n2.snippets[0].heading).toBe('Centrale')
      })

      it('trois extraits au plus, dans l ordre du texte', async () => {
        const r = await run({ text: 'lave' })
        expect(ids(r)).toEqual(['n7'])
        const snippets = r.hits[0].snippets
        expect(snippets.length).toBeGreaterThan(0)
        expect(snippets.length).toBeLessThanOrEqual(3)
        const parts = snippets.map(s => Number(/Partie (\d)/.exec(s.heading ?? '')?.[1]))
        expect(parts.every(n => n >= 1)).toBe(true)
        expect([...parts].sort((a, b) => a - b)).toEqual(parts)
        expectHighlights(r.hits[0], ['lave'])
        // Coupe d'un extrait marquee par « … ».
        expect(snippets.some(s => s.text.startsWith('…') || s.text.endsWith('…'))).toBe(true)
      })

      it('mots du titre surlignes', async () => {
        const r = await run({ text: 'centrale production' })
        expect(ids(r)).toEqual(['n2'])
        expect(r.hits[0].title).toBe('Centrale')
        expect(r.hits[0].path).toBe('Energie/Centrale.md')
        expect(r.hits[0].titleHighlights).toEqual([{ start: 0, end: 8 }])
        expectHighlights(r.hits[0], ['centrale', 'production'])
      })
    })

    describe('portee', () => {
      it('dossier, extensions, filtre sur les proprietes', async () => {
        const { engine } = await open()
        expect(ids(await engine.search({ text: 'reseau', folder: 'Notes' }))).toEqual(['n4'])
        expect(ids(await engine.search({ text: 'reseau', ext: ['outline'] }))).toEqual(['n4'])
        expect(ids(await engine.search({ text: 'reseau', ext: ['md'] }))).toEqual(['n1'])
        expect(ids(await engine.search({ text: 'travaux', where: { field: { prop: 'statut' }, op: 'eq', value: 'actif' } }))).toEqual(['n2'])
      })
    })

    describe('suivi', () => {
      it('ajout, modification et suppression sont vus', async () => {
        const { engine, upsert, remove } = await open()
        await upsert({ id: 'n8', path: 'Geologie/Etna.md', content: 'Un volcan actif.\n' })
        expect(sorted(await engine.search({ text: 'volcan' }))).toEqual(['n5', 'n6', 'n8'])
        await upsert({ id: 'n6', path: 'Geologie/Roches.md', content: 'Plus rien ici.\n' })
        await remove('n5')
        expect(ids(await engine.search({ text: 'volcan' }))).toEqual(['n8'])
      })

      it('etat de l index ; recherche annulee', async () => {
        const { engine } = await open()
        expect(engine.state().status).toBeTruthy()
        expect((await engine.search({ text: 'volcan' })).index.status).toBe(engine.state().status)
        const ctrl = new AbortController()
        ctrl.abort()
        await expect(engine.search({ text: 'volcan' }, { signal: ctrl.signal })).rejects.toMatchObject({ code: 'unavailable' })
      })
    })
  })
}
