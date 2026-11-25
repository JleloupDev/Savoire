// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Outils des bases sur le pair (ADR-033) : ChatGPT et Claude, par le MCP du
// serveur, creent une base, la remplissent, l'interrogent et la modifient.
// Le manifeste (arbre du document) et les lots de lignes (arbres annexes
// « id~lot-NNN ») sont rejoues depuis leurs journaux ; ce que l'outil y ecrit
// part a la fin de l'appel, en une ecriture, avec le ticket. Les types des
// proprietes du vault suivent le meme chemin (canal settings/properties).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeBackend } from './fakeBackend'
import { Peer, TOKEN, startPeer, tempDir, until } from './harness'

let backend: FakeBackend
let peer: Peer | undefined
let tmp: { dir: string; cleanup: () => void }

beforeEach(async () => {
  backend = await new FakeBackend({ token: TOKEN }).start()
  tmp = tempDir()
})

afterEach(async () => {
  await peer?.stop()
  peer = undefined
  await backend.stop()
  tmp.cleanup()
})

const actor = { agentId: 'ag', agentName: 'Bibliothécaire', onBehalfOf: { userId: 'u1', displayName: 'Jean' } }
const agent = { id: 'ag', name: 'Bibliothécaire', description: '', instructions: '', ownerId: 'u1', permissions: { read: 'direct', edit: 'direct', create: 'direct', delete: 'direct' } }

async function ready(): Promise<Peer> {
  peer = await startPeer(backend, tmp.dir)
  await until(async () => (await peer!.status('v1')).body.status === 'ready', 10_000, 'construction')
  return peer
}

type ToolReply = { text: string; isError: boolean }

async function call(p: Peer, name: string, args: Record<string, unknown>, opts: { mode?: string; access?: unknown } = {}): Promise<ToolReply> {
  const r = await p.call<ToolReply>('v1', 'tools', 'call', { name, args, mode: opts.mode ?? 'direct', ticket: 't1', actor, agent }, opts.access)
  expect(r.status).toBe(200)
  return r.body.result
}

/** Ce que le serveur a recu : une ligne par ecriture, ses operations. */
const ops = () => backend.writes.map(w => (w.body.ops ?? []).map(o => (o.target === 'index' ? `index:${o.ns}` : o.target === 'vault' ? 'vault' : `document:${o.docId}`)))

const COMPTES = [
  { id: 'r1', title: 'Loyer', values: { montant: 900, payé: false } },
  { id: 'r2', title: 'Assurance', values: { montant: 40 } },
]

/** Une base ecrite par un membre, ses lignes dans l'index du pair. */
async function comptes(path = 'Comptes.base', id = 'B'): Promise<Peer> {
  backend.writeBase('v1', id, path, COMPTES)
  const p = await ready()
  await until(async () => (await call(p, 'base_describe', { base: id })).text.includes('2 ligne(s)'), 15_000, 'lignes dans l’index')
  return p
}

describe('outils des bases sur le pair', () => {
  it('le catalogue propose les outils des bases', async () => {
    backend.writeNote('v1', 'a', 'A.md', 'x')
    const p = await ready()
    const r = await p.call<{ tools: { name: string }[] }>('v1', 'tools', 'list')
    expect(r.body.result.tools.map(t => t.name)).toEqual(expect.arrayContaining([
      'base_list', 'base_describe', 'base_query', 'base_create', 'base_update_schema', 'base_add_rows', 'base_update_rows', 'base_delete_rows',
    ]))
  })

  it('cree une base typee, la remplit en une ecriture, puis l interroge : filtre, tri, pages', async () => {
    backend.writeNote('v1', 'a', 'A.md', 'x')
    const p = await ready()
    const created = await call(p, 'base_create', {
      path: 'Projets/Livres',
      properties: [{ name: 'Auteur' }, { name: 'Prix', type: 'number' }, { name: 'Statut', type: 'select', options: ['À lire', 'Lu'] }],
    })
    expect(created).toMatchObject({ isError: false, text: 'Base créée : Projets/Livres.base, propriétés Auteur (text), Prix (number), Statut (select).' })
    const id = backend.writes.find(w => w.body.register?.length)!.body.register![0]!
    expect(backend.pathOf('v1', id)).toBe('Projets/Livres.base')
    expect(backend.baseManifest('v1', id).columns).toEqual(['Auteur', 'Prix', 'Statut'])
    expect(backend.propertyTypes('v1')).toEqual({ Prix: { type: 'number' }, Statut: { type: 'select', options: [{ value: 'À lire' }, { value: 'Lu' }] } })
    // Dossier, inscription, types du vault, manifeste, trace : tout avec le ticket.
    expect(ops()).toEqual([['vault'], ['vault'], ['index:settings/properties'], [`document:${id}`], ['index:map/review']])
    expect(backend.writes.every(w => w.body.ticket === 't1' && w.status === 200)).toBe(true)
    expect((await call(p, 'base_list', {})).text).toBe('1 base(s) :\n- Projets/Livres.base')

    // La base est connue tout de suite (lue dans l'arborescence, pas dans l'index).
    backend.writes.length = 0
    const added = await call(p, 'base_add_rows', {
      base: 'projets/livres',
      rows: [
        { title: 'Dune', values: { Auteur: 'Herbert', Prix: 12, Statut: 'Lu' } },
        { title: 'Fondation', values: { Auteur: 'Asimov', Prix: '9.5', Statut: 'À lire' } },
        { title: 'Hypérion', values: { Auteur: 'Simmons', Prix: 15, Statut: 'En cours' } },
      ],
    })
    expect(added.isError).toBe(false)
    expect(added.text).toMatch(/^3 ligne\(s\) ajoutée\(s\) à Projets\/Livres\.base :\n- Dune \(ligne [\w-]+\)\n- Fondation \(ligne [\w-]+\)\n- Hypérion \(ligne [\w-]+\)$/)
    expect(backend.baseRows('v1', id).map(r => [r.title, r.values])).toEqual([
      ['Dune', { Auteur: 'Herbert', Prix: 12, Statut: 'Lu' }],
      ['Fondation', { Auteur: 'Asimov', Prix: 9.5, Statut: 'À lire' }],
      ['Hypérion', { Auteur: 'Simmons', Prix: 15, Statut: 'En cours' }],
    ])
    // Un choix nouveau est declare ; le manifeste (lots connus) et les lots partent ensemble ; une trace, sur la base.
    expect(backend.propertyTypes('v1').Statut!.options).toEqual([{ value: 'À lire' }, { value: 'Lu' }, { value: 'En cours' }])
    const sent = ops()
    expect(sent).toHaveLength(3)
    expect(sent[0]).toEqual(['index:settings/properties'])
    expect(sent[1]![0]).toBe(`document:${id}`)
    expect(sent[1]!.slice(1).length).toBe(backend.baseManifest('v1', id).lots.length)
    expect(sent[1]!.slice(1).every(o => /~lot-\d{3}$/.test(o) && o.startsWith(`document:${id}~`))).toBe(true)
    expect(sent[2]).toEqual(['index:map/review'])
    expect(backend.reviewEntries('v1').at(-1)).toMatchObject({ kind: 'edit', docId: id, text: 'Ajouter des lignes à une base', author: { kind: 'agent', agentName: 'Bibliothécaire' } })

    // L'index suit avec un peu de retard.
    const q = (args: Record<string, unknown> = {}) => call(p, 'base_query', { base: 'Projets/Livres', ...args })
    await until(async () => (await q()).text.startsWith('Projets/Livres.base : 3 ligne(s) sur 3.'), 15_000, 'lignes dans l’index')
    const found = await q({
      filter: { and: [{ property: 'Prix', op: 'gte', value: 10 }, { or: [{ property: 'Statut', op: 'eq', value: 'lu' }, { property: 'Auteur', op: 'contains', value: 'SIMM' }] }] },
      sorts: [{ property: 'Prix', direction: 'desc' }],
    })
    expect(found.text.split('\n').map(l => l.replace(/\(ligne [\w-]+\)/, '(ligne)'))).toEqual([
      'Projets/Livres.base : 2 ligne(s) sur 2.',
      '- Hypérion (ligne) — Auteur: "Simmons", Prix: 15, Statut: "En cours"',
      '- Dune (ligne) — Auteur: "Herbert", Prix: 12, Statut: "Lu"',
    ])
    const page1 = await q({ sorts: [{ property: 'Prix' }], page_size: 2 })
    expect(page1.text).toMatch(/^Projets\/Livres\.base : 2 ligne\(s\) sur 3\.\n- Fondation .*\n- Dune .*\nSuite : même appel, avec cursor "[^"]+"\.$/)
    const page2 = await q({ sorts: [{ property: 'Prix' }], page_size: 2, cursor: /cursor "([^"]+)"/.exec(page1.text)![1] })
    expect(page2.text).toMatch(/^Projets\/Livres\.base : 1 ligne\(s\) sur 3\.\n- Hypérion [^\n]*$/)
    expect((await q({ filter: { property: 'Prix', op: 'entre' } })).isError).toBe(true)
  })

  it('decrit, modifie et supprime des lignes d une base existante : la difference du lot seulement', async () => {
    const p = await comptes()
    const d = await call(p, 'base_describe', { base: 'comptes' })
    expect(d.text.split('\n').slice(0, 2)).toEqual([
      'Comptes.base : 2 ligne(s), colonnes montant, payé.',
      'Propriétés : Nom (titre) ; montant (number) ; payé (checkbox).',
    ])
    const up = await call(p, 'base_update_rows', { base: 'B', rows: [{ row: 'r1', title: 'Loyer de mai', values: { montant: 950, payé: true } }, { row: 'r2', values: { montant: 40 } }] })
    expect(up).toMatchObject({ isError: false, text: '1 ligne(s) modifiée(s) dans Comptes.base (3 cellule(s)).' })
    expect(backend.baseRows('v1', 'B')).toEqual([
      { id: 'r2', title: 'Assurance', values: { montant: 40 } },
      { id: 'r1', title: 'Loyer de mai', values: { montant: 950, payé: true } },
    ])
    expect(backend.writes.map(w => w.body.ticket)).toEqual(['t1', 't1'])
    expect(ops()[0]).toHaveLength(1)
    expect(ops()[0]![0]).toMatch(/^document:B~lot-\d{3}$/)
    expect(ops()[1]).toEqual(['index:map/review'])
    expect(backend.reviewEntries('v1')).toMatchObject([{ kind: 'edit', docId: 'B', text: 'Modifier des lignes d’une base' }])

    expect(await call(p, 'base_delete_rows', { base: 'Comptes', rows: ['r2'] })).toMatchObject({ isError: false, text: '1 ligne(s) supprimée(s) de Comptes.base.' })
    expect(backend.baseRows('v1', 'B').map(r => r.id)).toEqual(['r1'])
  })

  it('modifie la structure : colonnes du manifeste, proprietes renommees dans les lignes, types du vault', async () => {
    const p = await comptes()
    const r = await call(p, 'base_update_schema', {
      base: 'Comptes',
      operations: [
        { op: 'add', property: 'Échéance', type: 'date' },
        { op: 'rename', property: 'montant', name: 'Montant' },
        { op: 'set_type', property: 'payé', type: 'checkbox' },
        { op: 'delete', property: 'payé' },
      ],
    })
    expect(r.isError).toBe(false)
    expect(r.text).toContain('- Renommée : montant devient Montant (2 ligne(s)).')
    expect(backend.baseManifest('v1', 'B').columns).toEqual(['Montant', 'Échéance'])
    expect(backend.baseRows('v1', 'B').map(x => x.values)).toEqual([{ Montant: 40 }, { Montant: 900, payé: false }])
    expect(backend.propertyTypes('v1')).toEqual({ Échéance: { type: 'date' }, payé: { type: 'checkbox' } })
    expect(backend.reviewEntries('v1')).toMatchObject([{ kind: 'edit', docId: 'B', text: 'Modifier la structure d’une base' }])
  })

  it('lignes-pages : une note par ligne, modifiee dans son frontmatter, puis a la corbeille', async () => {
    backend.writeNote('v1', 'a', 'A.md', 'x')
    const p = await ready()
    await call(p, 'base_create', { path: 'Tâches', properties: [{ name: 'État', type: 'status' }] })
    const base = backend.writes.find(w => w.body.register?.length)!.body.register![0]!
    backend.writes.length = 0
    const added = await call(p, 'base_add_rows', { base: 'Tâches', page: true, rows: [{ title: 'Écrire', values: { État: 'En cours' } }] })
    const note = backend.writes.find(w => w.body.register?.length)!.body.register![0]!
    expect(added).toMatchObject({ isError: false, text: `1 ligne(s) ajoutée(s) à Tâches.base :\n- Écrire (ligne ${note}, page Tâches/Écrire.md)` })
    expect(backend.pathOf('v1', note)).toBe('Tâches/Écrire.md')
    expect(backend.text('v1', note)).toBe('---\nÉtat: En cours\n---\n')
    // La note arrive dans l'index, puis se modifie comme une ligne.
    await until(async () => (await call(p, 'base_query', { base: base })).text.includes(`(ligne ${note}, page Tâches/Écrire.md) — État: "En cours"`), 15_000, 'page dans l’index')
    expect((await call(p, 'base_update_rows', { base: 'Tâches', rows: [{ row: note, values: { État: 'Terminé' } }] })).isError).toBe(false)
    expect(backend.text('v1', note)).toBe('---\nÉtat: Terminé\n---\n')
    expect((await call(p, 'base_delete_rows', { base: 'Tâches', rows: [note] })).text).toBe('1 ligne(s) supprimée(s) de Tâches.base (1 note(s) à la corbeille).')
    expect(backend.pathOf('v1', note)).toBe('.trash/Tâches/Écrire.md')
  })

  it('mode proposition : des propositions « base.cell », ni la ligne ni la structure ne changent', async () => {
    const p = await comptes()
    // Comme le serveur : un ticket en mode proposition n'ecrit que dans la Revision.
    backend.tickets.set('t1', 'propose')
    const r = await call(p, 'base_update_rows', { base: 'Comptes', rows: [{ row: 'r1', title: 'Loyer de mai', values: { montant: 950 } }] }, { mode: 'propose' })
    expect(r).toMatchObject({ isError: false, text: '2 proposition(s) déposée(s) dans la Révision de Comptes.base (1 ligne(s)).' })
    const row = { kind: 'light', baseId: 'B', rowId: 'r1' }
    expect(backend.reviewEntries('v1')).toMatchObject([
      { kind: 'proposal', docId: 'B', proposalType: 'base.cell', status: 'open', payload: { row, title: 'Loyer', key: '@title', before: 'Loyer', after: 'Loyer de mai' }, author: { kind: 'agent', agentName: 'Bibliothécaire' } },
      { kind: 'proposal', docId: 'B', proposalType: 'base.cell', status: 'open', payload: { row, title: 'Loyer', key: 'montant', before: 900, after: 950 }, text: 'Bibliothécaire propose montant = 950' },
    ])
    expect(ops()).toEqual([['index:map/review'], ['index:map/review']])
    // Structure, ajout, suppression, creation : refuses sans rien envoyer.
    backend.writes.length = 0
    for (const [name, args] of [
      ['base_update_schema', { base: 'Comptes', operations: [{ op: 'add', property: 'Note' }] }],
      ['base_add_rows', { base: 'Comptes', rows: [{ title: 'x' }] }],
      ['base_delete_rows', { base: 'Comptes', rows: ['r1'] }],
      ['base_create', { path: 'Autre' }],
    ] as const) {
      const refused = await call(p, name, args, { mode: 'propose' })
      expect(refused.isError, name).toBe(true)
      expect(refused.text, name).toContain('En mode proposition')
    }
    expect(backend.writes).toEqual([])
    expect(backend.baseRows('v1', 'B')).toEqual([{ id: 'r2', title: 'Assurance', values: { montant: 40 } }, { id: 'r1', title: 'Loyer', values: { montant: 900, payé: false } }])
    expect(backend.propertyTypes('v1')).toEqual({})
  })

  it('ACL : une base interdite a la personne n existe pas pour l agent', async () => {
    backend.writeBase('v1', 'S', 'Secret/Paie.base', COMPTES)
    const p = await comptes('Public/Comptes.base')
    const access = { base: 'write', rules: [{ folder: 'Secret', permission: 'none' }], closed: [] }
    expect((await call(p, 'base_list', {}, { access })).text).toBe('1 base(s) :\n- Public/Comptes.base')
    expect((await call(p, 'base_describe', { base: 'Public/Comptes' }, { access })).text).toContain('Loyer (ligne r1)')
    for (const [name, args] of [
      ['base_describe', { base: 'Secret/Paie' }],
      ['base_query', { base: 'S' }],
      ['base_add_rows', { base: 'S', rows: [{ title: 'x' }] }],
      ['base_update_rows', { base: 'Secret/Paie.base', rows: [{ row: 'r1', values: { montant: 1 } }] }],
      ['base_delete_rows', { base: 'S', rows: ['r1'] }],
      ['base_update_schema', { base: 'S', operations: [{ op: 'add', property: 'Note' }] }],
    ] as const) {
      const r = await call(p, name, args, { access })
      expect(r, name).toMatchObject({ isError: true })
      expect(r.text, name).toContain('Base introuvable')
      expect(r.text, name).not.toContain('Loyer')
    }
    expect(backend.writes).toEqual([])
    // Proprietaire : tout.
    expect((await call(p, 'base_list', {}, { access: { base: 'admin' } })).text).toBe('2 base(s) :\n- Public/Comptes.base\n- Secret/Paie.base')
  })

  it('un outil en echec n ecrit rien ; un refus du serveur est rendu a l IA', async () => {
    const p = await comptes()
    // Une ligne sur deux est fausse : la bonne n'est pas ajoutee.
    const bad = await call(p, 'base_add_rows', { base: 'Comptes', rows: [{ title: 'Bonne', values: { montant: 1 } }, { title: 'Fausse', values: { inconnue: 1 } }] })
    expect(bad.isError).toBe(true)
    expect(bad.text).toContain('Propriété inconnue dans Comptes.base : inconnue. Propriétés : montant, payé.')
    const gone = await call(p, 'base_update_rows', { base: 'Comptes', rows: [{ row: 'r1', values: { montant: 1 } }, { row: 'nope', values: { montant: 2 } }] })
    expect(gone.text).toContain('Ligne(s) introuvable(s) dans Comptes.base : nope')
    const schema = await call(p, 'base_update_schema', { base: 'Comptes', operations: [{ op: 'add', property: 'Note' }, { op: 'delete', property: 'inconnue' }] })
    expect(schema.isError).toBe(true)
    expect(backend.writes).toEqual([])
    expect(backend.baseManifest('v1', 'B').columns).toEqual([])
    // Le serveur refuse l'ecriture (droits de la personne) : l'outil echoue, rien n'est applique.
    backend.tickets.set('autre', 'direct')
    const denied = await call(p, 'base_update_rows', { base: 'Comptes', rows: [{ row: 'r1', values: { montant: 1 } }] })
    expect(denied.isError).toBe(true)
    expect(backend.writes.map(w => w.status)).toEqual([403])
    expect(backend.baseRows('v1', 'B').find(r => r.id === 'r1')!.values.montant).toBe(900)
  })
})
