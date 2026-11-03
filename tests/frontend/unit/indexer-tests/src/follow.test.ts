// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Suivi du flux : construction initiale, notes ajoutees et modifiees,
// regroupement des frappes, renommage, corbeille, suppression, vault-deleted,
// changement d'epoque, lignes legeres des bases.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { FakeBackend } from './fakeBackend'
import { Peer, TOKEN, sleep, startPeer, tempDir, until } from './harness'

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

describe('construction et suivi du flux', () => {
  it('construit un vault existant, puis le tient a jour (ajout, modification)', async () => {
    for (let i = 0; i < 30; i++) backend.writeNote('v1', `n${i}`, `Notes/Note ${i}.md`, `# Note ${i}\n\nmot${i} commun #tag${i % 3}`)
    peer = await startPeer(backend, tmp.dir)
    await until(async () => (await peer!.status('v1')).body.status === 'ready' && (await peer!.status('v1')).body.docs === 30, 10_000, 'construction')
    expect(await peer.found('v1', 'commun')).toHaveLength(30)
    expect(await peer.found('v1', 'mot7')).toEqual(['n7'])
    expect(existsSync(join(tmp.dir, 'v1.sqlite'))).toBe(true)

    backend.writeNote('v1', 'neuve', 'Neuve.md', 'une note toute neuve')
    await until(async () => (await peer!.found('v1', 'neuve')).length === 1, 5000, 'note neuve')
    backend.writeNote('v1', 'n3', 'Notes/Note 3.md', 'texte remplace')
    await until(async () => (await peer!.found('v1', 'remplace')).length === 1, 5000, 'note modifiee')
    expect(await peer.found('v1', 'mot3')).toEqual([])

    const tags = await peer.call<{ items: { tag: string; count: number }[] }>('v1', 'tags', 'list', {})
    expect(tags.status).toBe(200)
    expect(tags.body.result.items.map(t => t.tag).sort()).toEqual(['tag0', 'tag1', 'tag2'])
    const st = (await peer.status('v1')).body
    expect(st.seq).toBeGreaterThan(0)
    expect(st.bytes).toBeGreaterThan(0)
  })

  it('regroupe les frappes d une note : une seule relecture pour une rafale', async () => {
    peer = await startPeer(backend, tmp.dir, { SAVOIRE_INDEXER_DEBOUNCE_MS: '300', SAVOIRE_INDEXER_DEBOUNCE_MAX_MS: '5000' })
    backend.writeNote('v1', 'a', 'A.md', 'debut')
    await until(async () => (await peer!.found('v1', 'debut')).length === 1, 5000, 'note initiale')
    const before = backend.docReads.get('a') ?? 0
    for (let i = 0; i < 40; i++) {
      backend.type('v1', 'a', ` frappe${i}`)
      await sleep(5)
    }
    await until(async () => (await peer!.found('v1', 'frappe39')).length === 1, 5000, 'derniere frappe')
    // 40 frappes en ~0,3 s : une ou deux relectures, pas quarante.
    expect((backend.docReads.get('a') ?? 0) - before).toBeLessThanOrEqual(2)
  })

  it('renommage, corbeille et suppression suivent l arbre du vault', async () => {
    backend.writeNote('v1', 'a', 'Inbox/A.md', 'alpha')
    backend.writeNote('v1', 'b', 'B.md', 'beta [[A]]')
    backend.writeNote('v1', 'c', 'C.md', 'gamma')
    peer = await startPeer(backend, tmp.dir)
    await until(async () => (await peer!.found('v1', 'alpha')).length === 1, 5000, 'construction')

    const reads = backend.docReads.get('a')
    backend.rename('v1', 'a', 'Archives/A renommee.md')
    await until(async () => {
      const r = await peer!.call<{ rows: { id: string; path: string }[] }>('v1', 'query', 'run', { from: { notes: true, folder: 'Archives' } })
      return r.body.result.rows.length === 1 && r.body.result.rows[0]!.path === 'Archives/A renommee.md'
    }, 5000, 'renommage')
    // Un deplacement ne relit pas le contenu.
    expect(backend.docReads.get('a')).toBe(reads)
    // Le lien [[A]] de B suit toujours la note (nom de fichier change : non resolu).
    const out = await peer.call<{ resolved: unknown[]; unresolved: { target: string }[] }>('v1', 'links', 'outgoing', { id: 'b' })
    expect(out.body.result.unresolved.map(u => u.target)).toEqual(['A'])

    backend.rename('v1', 'b', '.trash/B.md')
    await until(async () => (await peer!.found('v1', 'beta')).length === 0, 5000, 'corbeille')
    backend.removeDoc('v1', 'c')
    await until(async () => (await peer!.found('v1', 'gamma')).length === 0, 5000, 'suppression')
    // Sortie de corbeille : relue.
    backend.rename('v1', 'b', 'B.md')
    await until(async () => (await peer!.found('v1', 'beta')).length === 1, 5000, 'sortie de corbeille')
  })

  it('vault-deleted : index ferme et supprime, appels refuses (409) ; retour au pair gere : reconstruit', async () => {
    backend.writeNote('v1', 'a', 'A.md', 'alpha')
    backend.writeNote('v2', 'b', 'B.md', 'beta')
    peer = await startPeer(backend, tmp.dir)
    await until(async () => (await peer!.found('v1', 'alpha')).length === 1, 5000, 'construction')
    backend.deleteVault('v1')
    await until(() => !existsSync(join(tmp.dir, 'v1.sqlite')), 5000, 'fichier supprime')
    const r = await peer.call('v1', 'search', 'run', { text: 'alpha' })
    expect(r.status).toBe(409)
    expect(r.body.error?.code).toBe('not_owner')
    expect(await peer.found('v2', 'beta')).toEqual(['b'])

    backend.writeNote('v1', 'a2', 'A2.md', 'revenu')
    await until(async () => (await peer!.found('v1', 'revenu')).length === 1, 5000, 'reconstruit')
  })

  it('epoque changee : tout est relu et reconstruit', async () => {
    backend.writeNote('v1', 'a', 'A.md', 'alpha')
    peer = await startPeer(backend, tmp.dir)
    await until(async () => (await peer!.found('v1', 'alpha')).length === 1, 5000, 'construction')
    const builds = await peer.metric('savoire_indexer_builds_total', { result: 'ok' })
    // Base du backend recreee : sequences depuis zero (plus basses que celles deja vues).
    backend.vaults.get('v1')!.docs.delete('a')
    backend.vaults.get('v1')!.tree.doc.getMap('vault').delete('a')
    backend.resetEpoch('epoch-2')
    backend.writeNote('v1', 'z', 'Z.md', 'apres la restauration')
    await until(async () => (await peer!.found('v1', 'restauration')).length === 1, 8000, 'reconstruction')
    await until(async () => (await peer!.found('v1', 'alpha')).length === 0, 5000, 'ancienne note partie')
    expect(await peer.metric('savoire_indexer_epoch_changes_total')).toBe(1)
    expect(await peer.metric('savoire_indexer_builds_total', { result: 'ok', mode: 'beside' })).toBeGreaterThanOrEqual(1)
    expect(builds).toBeGreaterThanOrEqual(1)
  })

  it('lignes legeres : une base et ses lots, cellule modifiee, ligne retiree, base a la corbeille', async () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ id: `r${i}`, title: `Ligne ${i}`, values: { prix: i, statut: i % 2 ? 'fait' : 'a faire' } }))
    backend.writeBase('v1', 'B1', 'Projets.base', rows)
    backend.writeNote('v1', 'n', 'N.md', 'une note')
    peer = await startPeer(backend, tmp.dir)
    const q = async (where?: unknown) => {
      const r = await peer!.call<{ rows: { id: string; values: Record<string, unknown> }[]; total: number }>('v1', 'query', 'run', { from: { base: 'B1' }, ...(where ? { where } : {}), limit: 500 })
      return r.body.result
    }
    await until(async () => (await q()).total === 40, 8000, 'lignes indexees')
    expect((await q({ field: { prop: 'statut' }, op: 'eq', value: 'fait' })).total).toBe(20)

    backend.setCell('v1', 'B1', 'r2', 'statut', 'fait')
    await until(async () => (await q({ field: { prop: 'statut' }, op: 'eq', value: 'fait' })).total === 21, 5000, 'cellule')
    backend.removeRow('v1', 'B1', 'r5')
    await until(async () => (await q()).total === 39, 5000, 'ligne retiree')

    backend.rename('v1', 'B1', '.trash/Projets.base')
    await until(async () => (await q()).total === 0, 5000, 'base a la corbeille')
    backend.rename('v1', 'B1', 'Projets.base')
    await until(async () => (await q()).total === 39, 5000, 'base restauree')
  })

  it('types des proprietes du vault : valeurs typees, index reconstruit quand ils changent', async () => {
    backend.writeNote('v1', 'a', 'A.md', '---\nprix: "12"\n---\nalpha')
    backend.writeNote('v1', 'b', 'B.md', '---\nprix: "3"\n---\nbeta')
    peer = await startPeer(backend, tmp.dir)
    const sum = async () => (await peer!.call<{ aggregates: unknown[] }>('v1', 'query', 'run', { from: { notes: true }, aggregate: [{ op: 'sum', field: { prop: 'prix' } }] })).body.result?.aggregates?.[0]
    await until(async () => (await peer!.found('v1', 'alpha')).length === 1, 5000, 'construction')
    // Sans type : du texte, hors des sommes.
    expect(await sum()).toBe(0)
    backend.setType('v1', 'prix', 'number')
    await until(async () => (await sum()) === 15, 10_000, 'reconstruction avec les types')
    // Une note modifiee ensuite est typee elle aussi.
    backend.writeNote('v1', 'b', 'B.md', '---\nprix: "5"\n---\nbeta')
    await until(async () => (await sum()) === 17, 5000, 'note typee au fil de l eau')
  })
})
