// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Pouvoir « tools » (ADR-033) : le pair execute les outils des agents pour les
// IA externes. Il lit les journaux, renvoie ses ecritures au serveur avec le
// ticket, et applique les regles d'acces (ACL) de la personne.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
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

const actor = { agentId: 'ag', agentName: 'Secrétaire', onBehalfOf: { userId: 'u1', displayName: 'Jean' } }
const agent = (permissions: Record<string, string>) => ({ id: 'ag', name: 'Secrétaire', description: '', instructions: '', ownerId: 'u1', permissions })

async function ready(env: Record<string, string> = {}): Promise<Peer> {
  peer = await startPeer(backend, tmp.dir, env)
  await until(async () => (await peer!.status('v1')).body.status === 'ready', 10_000, 'construction')
  return peer
}

type ToolReply = { text: string; isError: boolean; sources?: { path: string }[] }

function call(p: Peer, name: string, args: Record<string, unknown>, opts: { mode?: string; perms?: Record<string, string>; ticket?: string; access?: unknown } = {}) {
  return p.call<ToolReply>('v1', 'tools', 'call', {
    name, args, mode: opts.mode ?? 'direct', ticket: opts.ticket ?? 't1', actor,
    agent: agent(opts.perms ?? { read: 'direct', comment: 'direct', edit: 'direct', create: 'direct', organize: 'direct' }),
  }, opts.access)
}

describe('tools', () => {
  it('rend le catalogue du socle', async () => {
    backend.writeNote('v1', 'a', 'A.md', 'x')
    const p = await ready()
    const r = await p.call<{ tools: { name: string; action: string }[] }>('v1', 'tools', 'list')
    expect(r.status).toBe(200)
    expect(r.body.result.tools.map(t => t.name)).toEqual(expect.arrayContaining(['search', 'read_note', 'edit_note', 'append', 'create_note', 'move_note', 'comment']))
  })

  it('lit, puis ecrit dans la note : la modification part au serveur avec le ticket', async () => {
    backend.writeNote('v1', 'a', 'Projets/Plan.md', 'Bonjour le monde')
    const p = await ready()
    const read = await call(p, 'read_note', { path: 'projets/plan.md' })
    expect(read.body.result.text).toContain('Bonjour le monde')
    const r = await call(p, 'edit_note', { id: 'a', find: 'le monde', replace: 'tout le monde' })
    expect(r.body.result.isError).toBe(false)
    expect(backend.text('v1', 'a')).toBe('Bonjour tout le monde')
    expect(backend.writes.map(w => [w.body.ticket, w.body.ops?.map(o => o.target)])).toEqual([['t1', ['document']], ['t1', ['index']]])
    // La trace de l'ecriture, signee de l'agent.
    expect(backend.reviewEntries('v1')).toMatchObject([{ kind: 'edit', docId: 'a', author: { kind: 'agent', agentName: 'Secrétaire' } }])
  })

  it('mode proposition : une suggestion ancree, la note ne change pas', async () => {
    backend.writeNote('v1', 'a', 'A.md', 'Il ont manger')
    const p = await ready()
    const r = await call(p, 'edit_note', { id: 'a', find: 'Il ont manger', replace: 'Ils ont mangé' }, { mode: 'propose', perms: { read: 'direct', edit: 'direct' } })
    expect(r.body.result.isError).toBe(false)
    expect(backend.text('v1', 'a')).toBe('Il ont manger')
    const [entry] = backend.reviewEntries('v1')
    expect(entry).toMatchObject({ kind: 'suggestion', replacement: 'Ils ont mangé', anchor: { quote: 'Il ont manger' } })
    // L'ancre se relit dans le document du client, comme ReviewService.locate, meme apres une frappe avant.
    const doc = backend.vaults.get('v1')!.docs.get('a')!.doc
    doc.getText('codemirror').insert(0, 'Hier, ')
    const anchor = (entry as { anchor: { from: object; to: object } }).anchor
    const at = (rp: object) => Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(rp), doc)!.index
    expect(doc.getText('codemirror').toString().slice(at(anchor.from), at(anchor.to))).toBe('Il ont manger')
  })

  it('le serveur refuse : l outil le dit, rien ne change', async () => {
    backend.writeNote('v1', 'a', 'A.md', 'x')
    backend.tickets.set('t-propose', 'propose')
    const p = await ready()
    const r = await call(p, 'append', { id: 'a', text: 'y' }, { ticket: 't-propose' })
    expect(r.body.result.isError).toBe(true)
    expect(backend.text('v1', 'a')).toBe('x')
  })

  it('cree une note et la deplace, dossiers et placement annonces au serveur', async () => {
    backend.writeNote('v1', 'a', 'A.md', 'x')
    const p = await ready()
    const created = await call(p, 'create_note', { path: 'Réunions/2026-11-18', content: '# Compte rendu' })
    expect(created.body.result.text).toContain('Réunions/2026-11-18.md')
    const w = backend.writes.at(-1)!
    const id = w.body.register![0]!
    expect(w.body.folders).toEqual([{ docId: id, folder: 'Réunions' }])
    expect(backend.pathOf('v1', id)).toBe('Réunions/2026-11-18.md')
    expect(backend.text('v1', id)).toBe('# Compte rendu')
    await call(p, 'move_note', { id: 'a', to: 'Archives/' })
    expect(backend.pathOf('v1', 'a')).toBe('Archives/A.md')
  })

  it('deplacer une note fait suivre les liens des notes qui la citent (meme canal que l appli)', async () => {
    backend.writeNote('v1', 'a', 'Inbox/Idee.md', 'une idee')
    backend.writeNote('v1', 'c', 'Journal.md', 'Voir [[Idee]] et [[Autre]].')
    const p = await ready()
    const r = await call(p, 'move_note', { id: 'a', to: 'Archives/Projet.md' })
    expect(r.body.result.isError).toBe(false)
    expect(backend.pathOf('v1', 'a')).toBe('Archives/Projet.md')
    expect(backend.text('v1', 'c')).toBe('Voir [[Projet]] et [[Autre]].')
  })

  it('ACL : une note interdite a la personne n existe pas pour l agent', async () => {
    backend.writeNote('v1', 'a', 'Public/A.md', 'plan commun')
    backend.writeNote('v1', 's', 'Secret/S.md', 'plan secret')
    const p = await ready()
    const access = { base: 'write', rules: [{ folder: 'Secret', permission: 'none' }], closed: [] }
    const found = await call(p, 'search', { query: 'plan' }, { access })
    expect(found.body.result.sources?.map(s => s.path)).toEqual(['Public/A.md'])
    expect((await call(p, 'read_note', { path: 'Secret/S.md' }, { access })).body.result.isError).toBe(true)
    // Les autres pouvoirs aussi, par la meme regle.
    const search = await p.call<{ hits: { id: string }[] }>('v1', 'search', 'run', { text: 'plan' }, access)
    expect(search.body.result.hits.map(h => h.id)).toEqual(['a'])
    expect((await p.call('v1', 'documents', 'read', { id: 's' }, access)).status).toBe(404)
    expect((await p.call('v1', 'documents', 'read', { id: 's' }, { base: 'admin' })).status).toBe(200)
  })
})

/** Un plugin maison (VM d'organisation), un fichier .mjs. */
function homePlugin(dir: string, id: string, trust: string, tool: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${id}.mjs`), `export default {
  manifest: { id: '${id}', name: '${id}', version: '1.0.0', permissions: ['agents'], trust: '${trust}' },
  async onload(api) {
    api.views.register({ id: 'vue' })
    api.agents.registerTool({
      spec: { name: '${tool}', title: 'Ping', action: 'read', runtimes: ['app', 'server'], description: 'Ping.', inputSchema: { type: 'object', properties: {} } },
      async run() { return { text: 'pong ' + (await api.vault.list()).join(',') } },
    })
  },
  async onunload() {},
}
`)
}

describe('tools des plugins', () => {
  it('le catalogue contient les outils serveur des plugins livres avec Savoire', async () => {
    backend.writeNote('v1', 'a', 'A.md', 'x')
    const p = await ready()
    const r = await p.call<{ tools: { name: string; runtimes?: string[] }[] }>('v1', 'tools', 'list')
    const names = r.body.result.tools.map(t => t.name)
    expect(names).toEqual(expect.arrayContaining(['search', 'list_tasks', 'add_task', 'check_task', 'daily_note', 'append_to_daily', 'list_templates', 'create_from_template', 'insert_diagram', 'add_tag', 'rename_tag']))
    // Les outils qui ont besoin de l'ecran restent dans l'appli.
    expect(names).not.toContain('list_versions')
    expect(names).not.toContain('base_set_cell')
  })

  it('ChatGPT appelle add_task : la note change, la trace est signee de l agent', async () => {
    backend.writeNote('v1', 'a', 'Projets/Plan.md', '# Plan\n\n- [ ] Ecrire\n')
    const p = await ready()
    const r = await call(p, 'add_task', { path: 'projets/plan', text: 'Relire' })
    expect(r.body.result).toMatchObject({ isError: false, text: 'Tâche ajoutée à Projets/Plan.md.' })
    expect(backend.text('v1', 'a')).toBe('# Plan\n\n- [ ] Ecrire\n- [ ] Relire\n')
    expect(backend.writes.map(w => w.body.ticket)).toEqual(['t1', 't1'])
    expect(backend.reviewEntries('v1')).toMatchObject([{ kind: 'edit', docId: 'a', text: 'Ajouter une tâche', author: { kind: 'agent', agentName: 'Secrétaire' } }])
    const list = await call(p, 'list_tasks', {})
    expect(list.body.result.text).toContain('- [ ] Relire')
    const check = await call(p, 'check_task', { path: 'Projets/Plan.md', task: 'Ecrire' })
    expect(check.body.result.isError).toBe(false)
    expect(backend.text('v1', 'a')).toContain('- [x] Ecrire')
  })

  it('mode proposition : une proposition de texte dans la Revision, la note ne change pas', async () => {
    backend.writeNote('v1', 'a', 'A.md', 'Texte')
    const p = await ready()
    const r = await call(p, 'insert_diagram', { path: 'A.md', code: 'flowchart LR\n  a --> b' }, { mode: 'propose' })
    expect(r.body.result).toMatchObject({ isError: false, text: 'Schéma proposé dans A.md (Révision).' })
    expect(backend.text('v1', 'a')).toBe('Texte')
    expect(backend.reviewEntries('v1')).toMatchObject([{
      kind: 'proposal', docId: 'a', proposalType: 'savoire.text', status: 'open',
      payload: { at: 5, before: '', after: '\n\n```mermaid\nflowchart LR\n  a --> b\n```\n' },
      author: { kind: 'agent', agentName: 'Secrétaire' },
    }])
  })

  it('cree une note depuis un modele, puis ecrit dans la note du jour', async () => {
    backend.writeNote('v1', 't', 'Modèles/Réunion.md', '# {{title}}\n\n## Décisions\n')
    const p = await ready()
    expect((await call(p, 'list_templates', {})).body.result.text).toContain('Réunion')
    const r = await call(p, 'create_from_template', { template: 'Réunion', path: 'CR/Lundi' })
    expect(r.body.result.isError).toBe(false)
    const id = backend.writes.find(w => w.body.register?.length)!.body.register![0]!
    expect(backend.pathOf('v1', id)).toBe('CR/Lundi.md')
    expect(backend.text('v1', id)).toBe('# Lundi\n\n## Décisions\n')
    const d = await call(p, 'append_to_daily', { date: '2026-11-19', text: 'Appeler Paul' })
    expect(d.body.result.isError).toBe(false)
    const daily = backend.writes.filter(w => w.body.register?.length).at(-1)!.body.register![0]!
    expect(backend.pathOf('v1', daily)).toBe('Journal/2026-11-19.md')
    expect(backend.text('v1', daily)).toBe('Appeler Paul\n')
  })

  it('ACL : un outil de plugin ne voit pas les notes interdites', async () => {
    backend.writeNote('v1', 'a', 'Public/A.md', '- [ ] commune')
    backend.writeNote('v1', 's', 'Secret/S.md', '- [ ] secrete')
    const p = await ready()
    const access = { base: 'write', rules: [{ folder: 'Secret', permission: 'none' }], closed: [] }
    const list = await call(p, 'list_tasks', {}, { access })
    expect(list.body.result.text).toContain('commune')
    expect(list.body.result.text).not.toContain('secrete')
    expect((await call(p, 'add_task', { path: 'Secret/S.md', text: 'x' }, { access })).body.result.isError).toBe(true)
  })

  it('confiance : un plugin maison non verifie est refuse en mode verified, accepte en mode all', async () => {
    backend.writeNote('v1', 'a', 'A.md', 'x')
    const dir = join(tmp.dir, 'plugins')
    homePlugin(dir, 'plugin-maison', 'unverified', 'maison_ping')
    homePlugin(dir, 'plugin-relu', 'verified', 'relu_ping')
    const p = await ready({ SAVOIRE_INDEXER_PLUGIN_DIR: dir })
    const names = async () => (await p.call<{ tools: { name: string }[] }>('v1', 'tools', 'list')).body.result.tools.map(t => t.name)
    expect(await names()).toContain('relu_ping')
    expect(await names()).not.toContain('maison_ping')
    expect((await call(p, 'maison_ping', {})).body.result.isError).toBe(true)
    expect((await call(p, 'relu_ping', {})).body.result.text).toBe('pong A.md')
    await peer!.stop()
    const all = await ready({ SAVOIRE_INDEXER_PLUGIN_DIR: dir, SAVOIRE_INDEXER_PLUGIN_TRUST: 'all' })
    expect((await call(all, 'maison_ping', {})).body.result.text).toBe('pong A.md')
  })
})
