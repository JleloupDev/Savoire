// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Outils d'agent des bases, facon Notion (ADR-033) : creer une base et sa
// structure, ajouter, modifier et supprimer des lignes, l'interroger (filtre,
// tris, pages), et le mode proposition. Banc d'essai : un vault en memoire
// avec le vrai moteur de requetes de l'appli (baseHarness.ts).
import { describe, it, expect, vi } from 'vitest'
import { CELL_PROPOSAL, ManifestStore, baseAgentTools, parseCell, parseFilter, parseSorts, readManifest } from '@savoire/plugin-base'
import { annexDocId } from '@savoire/application'
import type { PluginAPI, QueryRow, ToolContext, ToolResult } from '@savoire/plugin-api'
import { tick, world, type Note } from './baseHarness'

const actor = { agentId: 'a', agentName: 'Bibliothécaire', onBehalfOf: { userId: 'u1', displayName: 'Alice' } }

function setup(initial: Omit<Note, 'id'>[] = []) {
  const w = world(initial)
  const m = w.member(0)
  let n = 0
  const propose = vi.fn(async (..._args: unknown[]) => `p${++n}`)
  const vault = Object.assign(w.vault, {
    sharedData: (id: string) => ({
      openMap: () => { throw new Error('inutile') },
      openTree: async (name: string) => w.tree(annexDocId(id, name), 0),
      closeTree: () => {},
    }),
  })
  const api = { ...m.api, vault, review: { propose } } as unknown as PluginAPI
  const tools = new Map(baseAgentTools(api).map(t => [t.spec.name, t]))
  const run = (name: string, args: Record<string, unknown>, mode: 'direct' | 'propose' = 'direct'): Promise<ToolResult> =>
    tools.get(name)!.run(args, { mode, actor } as ToolContext)
  /** Les lignes de la base, une fois l'index a jour. */
  const rows = async (base: string, args: Record<string, unknown> = {}): Promise<QueryRow[]> => {
    await tick()
    return ((await run('base_query', { base, page_size: 100, ...args })).data as { rows: QueryRow[] }).rows
  }
  return { w, m, api, propose, run, rows, tools }
}

const LIVRES = [
  { name: 'Auteur' },
  { name: 'Prix', type: 'number' },
  { name: 'Statut', type: 'select', options: ['À lire', 'Lu'] },
  { name: 'Tags', type: 'multiselect' },
  { name: 'Le', type: 'date' },
]

async function library() {
  const s = setup()
  const created = await s.run('base_create', { path: 'Livres', properties: LIVRES })
  const id = (created.data as { id: string }).id
  const added = await s.run('base_add_rows', {
    base: 'Livres',
    rows: [
      { title: 'Dune', values: { Auteur: 'Herbert', Prix: 12, Statut: 'Lu', Tags: ['sf', 'classique'], Le: '2026-11-24T10:30' } },
      { title: 'Fondation', values: { Auteur: 'Asimov', Prix: 9, Statut: 'À lire', Tags: ['sf'] } },
      { title: 'Hypérion', values: { Auteur: 'Simmons', Prix: 15, Statut: 'Lu', Le: '2026-11-20' } },
      { title: 'L’Étranger', values: { Auteur: 'Camus', Prix: 7, Tags: ['classique'] } },
      { title: 'Ubik', values: { Auteur: 'Dick', Statut: 'À lire' } },
    ],
  })
  const ids = Object.fromEntries((added.data as { rows: { id: string; title: string }[] }).rows.map(r => [r.title, r.id]))
  await tick()
  return { ...s, id, ids }
}

const titles = (r: ToolResult) => (r.data as { rows: QueryRow[] }).rows.map(x => x.title)

describe('outils des bases : structure', () => {
  it('le catalogue : les outils tournent dans l appli et sur le serveur, base_set_cell dans l appli', () => {
    const { tools } = setup()
    expect([...tools.keys()]).toEqual(['base_describe', 'base_set_cell', 'base_list', 'base_query', 'base_create', 'base_update_schema', 'base_add_rows', 'base_update_rows', 'base_delete_rows'])
    for (const [name, t] of tools) expect(t.spec.runtimes ?? ['app'], name).toEqual(name === 'base_set_cell' ? ['app'] : ['app', 'server'])
    expect(Object.fromEntries([...tools].map(([name, t]) => [name, t.spec.action]))).toMatchObject({
      base_describe: 'read', base_list: 'read', base_query: 'read', base_create: 'create', base_update_schema: 'edit',
      base_add_rows: 'create', base_update_rows: 'edit', base_delete_rows: 'delete',
    })
  })

  it('cree une base : colonnes dans l ordre, types declares dans le vault', async () => {
    const { w, m, run } = setup()
    const r = await run('base_create', { path: '/Lectures/Livres', properties: [...LIVRES, { name: 'État', type: 'status' }] })
    expect(r.text).toBe('Base créée : Lectures/Livres.base, propriétés Auteur (text), Prix (number), Statut (select), Tags (multiselect), Le (date), État (status).')
    const id = (r.data as { id: string }).id
    expect(w.notes.find(n => n.id === id)?.path).toBe('Lectures/Livres.base')
    // L'autre membre recoit la structure.
    const manifest = readManifest(w.tree(id, 1), '')
    expect(manifest.columns.map(c => c.key)).toEqual(['Auteur', 'Prix', 'Statut', 'Tags', 'Le', 'État'])
    expect(manifest.source.folder).toBe('Lectures/Livres')
    expect(m.types.get('Prix')).toEqual({ key: 'Prix', type: 'number' })
    expect(m.types.get('Statut')?.options?.map(o => o.value)).toEqual(['À lire', 'Lu'])
    expect(m.types.get('État')?.options?.map(o => o.value)).toEqual(['Pas commencé', 'En cours', 'Terminé'])
    // Texte : le type par defaut, rien a declarer.
    expect(m.types.get('Auteur')).toBeUndefined()
    expect((await run('base_list', {})).text).toBe('2 base(s) :\n- Lectures/Livres.base\n- Projets.base')
    expect((await run('base_describe', { base: 'lectures/livres' })).text).toBe(
      'Lectures/Livres.base : 0 ligne(s), colonnes Auteur, Prix, Statut, Tags, Le, État.\n'
      + 'Propriétés : Nom (titre) ; Auteur (text) ; Prix (number) ; Statut (select : À lire, Lu) ; Tags (multiselect) ; Le (date) ; État (status : Pas commencé, En cours, Terminé).')
  })

  it('refuse avant de creer : chemin pris, type inconnu, type du vault different', async () => {
    const { w, m, run } = setup()
    m.types.set({ key: 'Prix', type: 'number' })
    await expect(run('base_create', { path: 'Projets' })).rejects.toThrow('Un document existe déjà : Projets.base.')
    await expect(run('base_create', { path: 'A', properties: [{ name: 'x', type: 'couleur' }] })).rejects.toThrow('Type inconnu : couleur')
    await expect(run('base_create', { path: 'A', properties: [{ name: 'Lien', type: 'relation' }] })).rejects.toThrow('pas encore par ces outils')
    await expect(run('base_create', { path: 'A', properties: [{ name: 'title' }] })).rejects.toThrow('réservé au nom de la ligne')
    await expect(run('base_create', { path: 'A', properties: [{ name: 'Prix', type: 'text' }] })).rejects.toThrow('déjà une propriété du vault, de type number')
    await expect(run('base_create', { path: 'A', properties: [{ name: 'a' }, { name: 'a' }] })).rejects.toThrow('deux fois')
    expect(w.notes.some(n => n.path === 'A.base')).toBe(false)
  })

  it('modifie la structure : ajouter, renommer partout, changer le type, retirer', async () => {
    const { w, m, run } = setup([
      { path: 'Projets/A.md', text: '---\netat: Fait\nprix: 10\n---\nTexte' },
      { path: 'Projets/B.md', text: '---\netat: En cours\n---\n' },
    ])
    // Une vue triee sur la propriete : le renommage la suit.
    new ManifestStore(w.tree('base1', 0), () => readManifest(w.tree('base1', 0), 'Projets')).setView('v1', { sorts: [{ key: 'etat', dir: 'asc' }] })
    await tick()
    expect((await run('base_describe', { base: 'Projets' })).text).toContain('Projets.base : 2 ligne(s), colonnes etat, prix.')
    const r = await run('base_update_schema', {
      base: 'Projets',
      operations: [
        { op: 'add', property: 'Échéance', type: 'date' },
        { op: 'rename', property: 'etat', name: 'État' },
        { op: 'set_type', property: 'État', type: 'select', options: ['Fait', 'En cours'] },
        { op: 'delete', property: 'prix' },
      ],
    })
    expect(r.text).toBe([
      'Projets.base, structure modifiée :',
      '- Ajoutée : Échéance (date).',
      '- Renommée : etat devient État (2 ligne(s)).',
      '- Type : État est select (Fait, En cours), pour tout le vault.',
      '- Retirée de la base : prix (ses valeurs restent dans les lignes).',
    ].join('\n'))
    const manifest = readManifest(w.tree('base1', 1), 'Projets')
    expect(manifest.columns.map(c => c.key)).toEqual(['État', 'Échéance'])
    expect(manifest.views[0]!.sorts).toEqual([{ key: 'État', dir: 'asc' }])
    expect(w.notes.find(n => n.path === 'Projets/A.md')!.text).toBe('---\nÉtat: Fait\nprix: 10\n---\nTexte')
    expect(w.notes.find(n => n.path === 'Projets/B.md')!.text).toContain('État: En cours')
    expect(m.types.get('État')).toMatchObject({ type: 'select', options: [{ value: 'Fait' }, { value: 'En cours' }] })
    expect(m.types.get('Échéance')).toEqual({ key: 'Échéance', type: 'date' })
  })

  it('une operation fausse : rien n est change, meme ce qui precedait', async () => {
    const { w, m, run } = setup([{ path: 'Projets/A.md', text: '---\netat: Fait\n---\n' }])
    await tick()
    const ops = (more: Record<string, unknown>) => run('base_update_schema', { base: 'Projets', operations: [{ op: 'add', property: 'Prix', type: 'number' }, more] })
    await expect(ops({ op: 'delete', property: 'inconnue' })).rejects.toThrow('Propriété inconnue dans Projets.base : inconnue. Propriétés : etat, Prix.')
    await expect(ops({ op: 'rename', property: 'etat', name: 'Prix' })).rejects.toThrow('existe déjà')
    await expect(ops({ op: 'fusionner', property: 'etat' })).rejects.toThrow('Opération inconnue : fusionner')
    await expect(ops({ op: 'add', property: 'Prix' })).rejects.toThrow('existe déjà')
    expect(readManifest(w.tree('base1', 0), 'Projets').stored).toBe(false)
    expect(m.types.get('Prix')).toBeUndefined()
    // Structure verrouillee dans l'appli : on n'y touche pas.
    new ManifestStore(w.tree('base1', 0), () => readManifest(w.tree('base1', 0), 'Projets')).setLocked(true)
    await expect(run('base_update_schema', { base: 'Projets', operations: [{ op: 'add', property: 'Prix' }] })).rejects.toThrow('verrouillée')
  })
})

describe('outils des bases : lignes', () => {
  it('ajoute des lignes legeres : valeurs ramenees au type, choix declares, numero pose', async () => {
    const { m, run, rows } = setup()
    await run('base_create', { path: 'T', properties: [...LIVRES, { name: 'Lu', type: 'checkbox' }, { name: 'N°', type: 'id' }] })
    const r = await run('base_add_rows', {
      base: 'T',
      rows: [
        { title: 'Dune', values: { Auteur: 'Herbert', Prix: '12,5', Statut: 'En cours', Tags: 'sf', Le: '2026-11-24', Lu: 'oui' } },
        { title: ' ', values: { Prix: 3, Lu: false, Auteur: '' } },
      ],
    })
    expect(r.text).toMatch(/^2 ligne\(s\) ajoutée\(s\) à T\.base :\n- Dune \(ligne [\w-]+\)\n- Sans titre \(ligne [\w-]+\)$/)
    const all = await rows('T', { sorts: [{ property: 'N°' }] })
    expect(all.map(x => [x.title, x.path, x.values])).toEqual([
      ['Dune', '', { Auteur: 'Herbert', Prix: 12.5, Statut: 'En cours', Tags: ['sf'], Le: '2026-11-24', Lu: true, 'N°': 1 }],
      ['Sans titre', '', { Prix: 3, Lu: false, 'N°': 2 }],
    ])
    // Une valeur saisie dans un choix devient une option (comme dans la vue).
    expect(m.types.get('Statut')?.options?.map(o => o.value)).toEqual(['À lire', 'Lu', 'En cours'])
    // Le numero continue.
    await run('base_add_rows', { base: 'T', rows: [{ title: 'Ubik' }] })
    expect((await rows('T', { filter: { property: 'Nom', op: 'eq', value: 'ubik' } }))[0]!.values['N°']).toBe(3)
  })

  it('une ligne fausse : rien n est ajoute', async () => {
    const { run, rows } = setup()
    await run('base_create', { path: 'T', properties: [...LIVRES, { name: 'N°', type: 'id' }] })
    const add = (values: Record<string, unknown>) => run('base_add_rows', { base: 'T', rows: [{ title: 'Bonne', values: { Prix: 1 } }, { title: 'Fausse', values }] })
    await expect(add({ Editeur: 'x' })).rejects.toThrow('Propriété inconnue dans T.base : Editeur. Propriétés : Auteur, Prix, Statut, Tags, Le, N°.')
    await expect(add({ Prix: 'cher' })).rejects.toThrow('« Prix » : un nombre attendu, reçu "cher".')
    await expect(add({ Le: 'demain' })).rejects.toThrow('une date ISO')
    await expect(add({ Statut: ['a', 'b'] })).rejects.toThrow('une seule valeur attendu')
    await expect(add({ 'N°': 7 })).rejects.toThrow('remplie par Savoire')
    await expect(add({ Nom: 'x' })).rejects.toThrow('dans title')
    await expect(run('base_add_rows', { base: 'T', rows: [] })).rejects.toThrow('Donnez les lignes')
    await expect(run('base_add_rows', { base: 'T', rows: Array.from({ length: 101 }, () => ({ title: 'x' })) })).rejects.toThrow('100 au plus')
    expect(await rows('T')).toEqual([])
  })

  it('modifie des lignes : les cellules donnees seulement, null efface, title renomme', async () => {
    const { run, rows, ids } = await library()
    const r = await run('base_update_rows', {
      base: 'Livres',
      rows: [
        { row: ids.Dune, title: 'Dune, tome 1', values: { Prix: 13, Tags: null, Statut: 'Lu' } },
        { row: ids.Ubik, values: { Prix: '8' } },
      ],
    })
    // Statut de Dune valait deja « Lu » : pas compte.
    expect(r.text).toBe('2 ligne(s) modifiée(s) dans Livres.base (4 cellule(s)).')
    const after = Object.fromEntries((await rows('Livres')).map(x => [x.title, x.values]))
    expect(after['Dune, tome 1']).toEqual({ Auteur: 'Herbert', Prix: 13, Statut: 'Lu', Le: '2026-11-24T10:30' })
    expect(after.Ubik).toEqual({ Auteur: 'Dick', Statut: 'À lire', Prix: 8 })
    expect((await run('base_update_rows', { base: 'Livres', rows: [{ row: ids.Ubik, values: { Prix: 8 } }] })).text).toBe('Rien à changer dans Livres.base.')
    // Une ligne inconnue ou une valeur fausse : rien ne change, meme pour les autres lignes.
    await expect(run('base_update_rows', { base: 'Livres', rows: [{ row: ids.Ubik, values: { Prix: 1 } }, { row: 'nope', values: { Prix: 2 } }] })).rejects.toThrow('Ligne(s) introuvable(s) dans Livres.base : nope')
    await expect(run('base_update_rows', { base: 'Livres', rows: [{ row: ids.Ubik, values: { Prix: 1 } }, { row: ids.Dune, values: { Prix: 'x' } }] })).rejects.toThrow('un nombre attendu')
    expect((await rows('Livres')).find(x => x.title === 'Ubik')!.values.Prix).toBe(8)
  })

  it('supprime des lignes ; une ligne introuvable : rien n est supprime', async () => {
    const { run, rows, ids } = await library()
    await expect(run('base_delete_rows', { base: 'Livres', rows: [ids.Dune, 'nope'] })).rejects.toThrow('Ligne(s) introuvable(s) dans Livres.base : nope')
    expect(await rows('Livres')).toHaveLength(5)
    expect((await run('base_delete_rows', { base: 'Livres', rows: [ids.Dune, ids.Ubik] })).text).toBe('2 ligne(s) supprimée(s) de Livres.base.')
    expect((await rows('Livres')).map(x => x.title)).toEqual(['Fondation', 'Hypérion', 'L’Étranger'])
  })

  it('lignes-pages : une note par ligne, valeurs en frontmatter, renommee, puis a la corbeille', async () => {
    const { w, run, rows } = setup()
    await run('base_create', { path: 'Projets/Tâches', properties: [{ name: 'État', type: 'status' }, { name: 'Charge', type: 'number' }] })
    const r = await run('base_add_rows', { base: 'Projets/Tâches', page: true, rows: [{ title: 'Écrire', values: { État: 'En cours', Charge: 2 } }] })
    const note = w.notes.find(n => n.path === 'Projets/Tâches/Écrire.md')!
    expect(r.text).toBe(`1 ligne(s) ajoutée(s) à Projets/Tâches.base :\n- Écrire (ligne ${note.id}, page Projets/Tâches/Écrire.md)`)
    expect(note.text).toBe('---\nÉtat: En cours\nCharge: 2\n---\n')
    expect((await rows('Projets/Tâches')).map(x => [x.id, x.path, x.values])).toEqual([[note.id, 'Projets/Tâches/Écrire.md', { État: 'En cours', Charge: 2 }]])
    const up = await run('base_update_rows', { base: 'Projets/Tâches', rows: [{ row: note.id, title: 'Rédiger', values: { État: 'Terminé', Charge: null } }] })
    expect(up.text).toBe('1 ligne(s) modifiée(s) dans Projets/Tâches.base (3 cellule(s)).')
    expect(note.text).toBe('---\nÉtat: Terminé\n---\n')
    expect(note.path).toBe('Projets/Tâches/Rédiger.md')
    // Une note d'ailleurs n'est pas une ligne de cette base.
    w.notes.push({ id: 'x1', path: 'Ailleurs/Note.md', text: '' })
    await expect(run('base_update_rows', { base: 'Projets/Tâches', rows: [{ row: 'x1', values: { Charge: 1 } }] })).rejects.toThrow('Ailleurs/Note.md n’est pas une ligne de Projets/Tâches.base.')
    expect((await run('base_delete_rows', { base: 'Projets/Tâches', rows: [note.id] })).text).toBe('1 ligne(s) supprimée(s) de Projets/Tâches.base (1 note(s) à la corbeille).')
    expect(w.vault.deleteFile).toHaveBeenCalledWith(note.id)
  })
})

describe('outils des bases : requetes', () => {
  it('filtre : comparaisons, vide, texte sans casse, liste, date au jour, et / ou imbriques', async () => {
    const { run } = await library()
    const q = async (filter: unknown) => titles(await run('base_query', { base: 'Livres', filter }))
    expect(await q({ property: 'Prix', op: 'gt', value: 9 })).toEqual(['Dune', 'Hypérion'])
    expect(await q({ property: 'Prix', op: 'lte', value: '9' })).toEqual(['Fondation', 'L’Étranger'])
    expect(await q({ property: 'Prix', op: 'empty' })).toEqual(['Ubik'])
    expect(await q({ property: 'Statut', op: 'neq', value: 'Lu' })).toEqual(['Fondation', 'Ubik'])
    expect(await q({ property: 'Auteur', op: 'contains', value: 'SIM' })).toEqual(['Fondation', 'Hypérion'])
    expect(await q({ property: 'Nom', op: 'contains', value: 'etranger' })).toEqual(['L’Étranger'])
    expect(await q({ property: 'Tags', op: 'eq', value: 'classique' })).toEqual(['Dune', 'L’Étranger'])
    expect(await q({ property: 'Tags', op: 'not_empty' })).toEqual(['Dune', 'Fondation', 'L’Étranger'])
    // « est le 24 » vaut aussi pour le 24 a 10 h 30.
    expect(await q({ property: 'Le', op: 'eq', value: '2026-11-24' })).toEqual(['Dune'])
    expect(await q({ property: 'Le', op: 'lt', value: '2026-11-24' })).toEqual(['Hypérion'])
    expect(await q({
      and: [
        { property: 'Statut', op: 'not_empty' },
        { or: [{ property: 'Prix', op: 'gte', value: 15 }, { and: [{ property: 'Tags', op: 'contains', value: 'sf' }, { property: 'Prix', op: 'lt', value: 10 }] }] },
      ],
    })).toEqual(['Fondation', 'Hypérion'])
  })

  it('trie et pagine : un curseur jusqu a la fin, sans doublon', async () => {
    const { run } = await library()
    const args = { base: 'Livres', sorts: [{ property: 'Statut', direction: 'desc' }, { property: 'Prix', direction: 'asc' }], page_size: 2 }
    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const r = await run('base_query', { ...args, ...(cursor ? { cursor } : {}) })
      const d = r.data as { rows: QueryRow[]; total: number; next?: string }
      expect(d.total).toBe(5)
      expect(r.text.split('\n')[0]).toBe(`Livres.base : ${d.rows.length} ligne(s) sur 5.`)
      expect(r.text.includes('Suite : même appel, avec cursor "')).toBe(!!d.next)
      if (d.next) expect(/cursor "([^"]+)"/.exec(r.text)![1]).toBe(d.next)
      seen.push(...d.rows.map(x => x.title))
      cursor = d.next
      pages++
    } while (cursor)
    expect(pages).toBe(3)
    // Lu avant « À lire » (decroissant), puis par prix ; les vides en dernier.
    expect(seen).toEqual(['Dune', 'Hypérion', 'Fondation', 'Ubik', 'L’Étranger'])
    await expect(run('base_query', { ...args, cursor: 'nimporte' })).rejects.toThrow()
  })

  it('rend les valeurs, les proprietes demandees, et signale une propriete inconnue', async () => {
    const { run, ids } = await library()
    const one = await run('base_query', { base: 'Livres', filter: { property: 'Nom', op: 'eq', value: 'Dune' } })
    expect(one.text).toBe(`Livres.base : 1 ligne(s) sur 1.\n- Dune (ligne ${ids.Dune}) — Auteur: "Herbert", Prix: 12, Statut: "Lu", Tags: ["sf","classique"], Le: "2026-11-24T10:30"`)
    const few = await run('base_query', { base: 'Livres', properties: ['Prix'], sorts: [{ property: 'Prix', direction: 'desc' }], page_size: 1 })
    expect(few.text.split('\n')[1]).toBe(`- Hypérion (ligne ${ids['Hypérion']}) — Prix: 15`)
    const none = await run('base_query', { base: 'Livres', filter: { property: 'Editeur', op: 'eq', value: 'x' } })
    expect(none.text).toBe('Livres.base : 0 ligne(s) sur 0.\nPropriété(s) inconnue(s) de cette base : Editeur. Propriétés : Auteur, Prix, Statut, Tags, Le.')
    await expect(run('base_query', { base: 'Livres', filter: { property: 'Prix', op: 'entre', value: 1 } })).rejects.toThrow('Opérateur inconnu : entre. Possibles : eq, neq, contains, gt, lt, gte, lte, empty, not_empty.')
    await expect(run('base_query', { base: 'Livres', filter: { property: 'Prix', op: 'gt' } })).rejects.toThrow('donnez une valeur')
    await expect(run('base_query', { base: 'Livres', sorts: [{ property: 'Prix', direction: 'haut' }] })).rejects.toThrow('Sens de tri inconnu')
    await expect(run('base_query', { base: 'Nulle part' })).rejects.toThrow('Base introuvable : Nulle part.')
  })

  it('arguments : filtre, tris et valeurs, lus sans base', () => {
    const ctx = { keys: ['Prix', 'Le'], typeOf: (k: string) => (k === 'Prix' ? 'number' as const : k === 'Le' ? 'date' as const : 'text' as const) }
    expect(parseFilter({ property: 'Prix', op: 'gt', value: '10' }, ctx)).toEqual({ where: { field: { prop: 'Prix' }, op: 'gt', value: 10 }, properties: ['Prix'] })
    expect(parseFilter({ or: [{ property: 'Nom', op: 'contains', value: 'a' }, { property: 'x', op: 'not_empty' }] }, ctx)).toEqual({
      where: { or: [{ field: { doc: 'title' }, op: 'contains', value: 'a' }, { field: { prop: 'x' }, op: 'notEmpty' }] }, properties: ['x'],
    })
    expect(parseFilter({ property: 'Le', op: 'eq', value: '2026-11-24' }, ctx).where).toEqual({
      and: [{ field: { prop: 'Le' }, op: 'gte', value: '2026-11-24' }, { field: { prop: 'Le' }, op: 'lt', value: '2026-11-25' }],
    })
    expect(parseFilter(undefined, ctx)).toEqual({ properties: [] })
    expect(parseFilter({ and: [] }, ctx)).toEqual({ properties: [] })
    expect(() => parseFilter('Prix > 10', ctx)).toThrow('Filtre illisible')
    expect(() => parseFilter({ and: [{ and: [{ and: [{ and: [{ and: [] }] }] }] }] }, ctx)).toThrow('trop imbriqué')
    // Une propriete nommee « Nom » l'emporte sur le titre.
    expect(parseSorts([{ property: 'Nom' }], { keys: ['Nom'] })).toEqual([{ field: { prop: 'Nom' }, dir: 'asc' }])
    expect(parseSorts([{ property: 'Nom', direction: 'descending' }], ctx)).toEqual([{ field: { doc: 'title' }, dir: 'desc' }])
    expect(parseSorts(undefined, ctx)).toEqual([{ field: { doc: 'title' } }])
    expect(parseCell('x', { type: 'number' }, '3,5')).toBe(3.5)
    expect(parseCell('x', { type: 'checkbox' }, 'non')).toBe(false)
    expect(parseCell('x', { type: 'multiselect' }, 'a')).toEqual(['a'])
    expect(parseCell('x', { type: 'person', multiple: true }, ['u1', 'u2'])).toEqual(['u1', 'u2'])
    expect(parseCell('x', { type: 'select' }, 3)).toBe('3')
    expect(parseCell('x', { type: 'text' }, '')).toBeNull()
    // Sans type declare : la valeur telle quelle.
    expect(parseCell('x', undefined, 3)).toBe(3)
    expect(parseCell('x', undefined, ['a', 1])).toEqual(['a', '1'])
    expect(() => parseCell('=Total', undefined, 1)).toThrow('colonne calculée')
    expect(() => parseCell('x', { type: 'text' }, { a: 1 })).toThrow('attendu')
  })
})

describe('outils des bases : mode proposition', () => {
  it('une cellule changee devient une proposition « base.cell », rien n est ecrit', async () => {
    const { w, run, rows, propose, ids } = await library()
    await run('base_add_rows', { base: 'Livres', page: true, rows: [{ title: 'Solaris', values: { Prix: 11 } }] })
    const note = w.notes.find(n => n.path === 'Livres/Solaris.md')!
    const before = note.text
    const r = await run('base_update_rows', {
      base: 'Livres',
      rows: [{ row: ids.Dune, title: 'Dune 1', values: { Prix: 14, Statut: 'Lu' } }, { row: note.id, values: { Prix: null, Statut: 'Abandonné' } }],
    }, 'propose')
    expect(r.text).toBe('4 proposition(s) déposée(s) dans la Révision de Livres.base (2 ligne(s)).')
    expect((r.data as { proposalIds: string[] }).proposalIds).toEqual(['p1', 'p2', 'p3', 'p4'])
    const base = w.notes.find(n => n.path === 'Livres.base')!.id
    const light = { kind: 'light', baseId: base, rowId: ids.Dune }
    const page = { kind: 'page', docId: note.id, path: 'Livres/Solaris.md' }
    expect(propose.mock.calls.map(c => c.slice(0, 3))).toEqual([
      [base, CELL_PROPOSAL, { row: light, title: 'Dune', key: '@title', before: 'Dune', after: 'Dune 1' }],
      [base, CELL_PROPOSAL, { row: light, title: 'Dune', key: 'Prix', before: 12, after: 14 }],
      [base, CELL_PROPOSAL, { row: page, title: 'Solaris', key: 'Prix', before: 11, after: null }],
      [base, CELL_PROPOSAL, { row: page, title: 'Solaris', key: 'Statut', before: null, after: 'Abandonné' }],
    ])
    expect(propose.mock.calls[1]![3]).toBe('Bibliothécaire propose Prix = 14')
    // Rien n'a change : ni la ligne, ni la note, ni les choix declares.
    expect((await rows('Livres')).find(x => x.id === ids.Dune)).toMatchObject({ title: 'Dune', values: { Prix: 12 } })
    expect(note.text).toBe(before)
    expect(w.member(0).types.get('Statut')?.options?.map(o => o.value)).toEqual(['À lire', 'Lu'])
  })

  it('creer, ajouter, supprimer, changer la structure : refuses, rien n est ecrit', async () => {
    const { w, run, rows, propose, ids } = await library()
    const refused = 'En mode proposition, un agent'
    await expect(run('base_create', { path: 'Autre' }, 'propose')).rejects.toThrow(refused)
    await expect(run('base_add_rows', { base: 'Livres', rows: [{ title: 'x' }] }, 'propose')).rejects.toThrow(refused)
    await expect(run('base_delete_rows', { base: 'Livres', rows: [ids.Dune] }, 'propose')).rejects.toThrow(refused)
    await expect(run('base_update_schema', { base: 'Livres', operations: [{ op: 'delete', property: 'Prix' }] }, 'propose')).rejects.toThrow(refused)
    expect(w.notes.some(n => n.path === 'Autre.base')).toBe(false)
    expect(await rows('Livres')).toHaveLength(5)
    expect(readManifest(w.tree(w.notes.find(n => n.path === 'Livres.base')!.id, 0), '').columns).toHaveLength(5)
    expect(propose).not.toHaveBeenCalled()
  })
})
