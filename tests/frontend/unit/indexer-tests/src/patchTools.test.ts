// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Lire et ecrire une note par morceaux sur le pair (ADR-033) : ChatGPT et
// Claude, par le MCP du serveur, lisent une section, demandent ce qui a
// change, et retouchent un bloc (patch_note). Le pair garde en memoire ce
// que chaque agent a lu, d'un appel a l'autre. Un long texte part en
// plusieurs ecritures, avec le meme ticket (effet de frappe).
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
const agent = { id: 'ag', name: 'Secrétaire', description: '', instructions: '', ownerId: 'u1', permissions: { read: 'direct', edit: 'direct' } }

async function ready(): Promise<Peer> {
  peer = await startPeer(backend, tmp.dir)
  await until(async () => (await peer!.status('v1')).body.status === 'ready', 10_000, 'construction')
  return peer
}

type ToolReply = { text: string; isError: boolean }

async function call(p: Peer, name: string, args: Record<string, unknown>, mode = 'direct'): Promise<ToolReply> {
  const r = await p.call<ToolReply>('v1', 'tools', 'call', { name, args, mode, ticket: 't1', actor, agent })
  expect(r.status).toBe(200)
  return r.body.result
}

const NOTE = '# Plan\n\nIntroduction. ^intro\n\n## MCP\n\nLe serveur parle aux IA.\n\n## Suite\n\nLa suite.'
const refIn = (text: string, startsWith: string): string => new RegExp(`‹([^›]+)›\\n${startsWith}`).exec(text)![1]!
const versionOf = (text: string): string => /Version : (v[0-9a-f]+)/.exec(text)![1]!
const docWrites = () => backend.writes.filter(w => w.body.ops?.some(o => o.target === 'document'))
const ytext = (id: string) => backend.vaults.get('v1')!.docs.get(id)!.doc.getText('codemirror')
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64')

describe('lecture et ecriture fines sur le pair', () => {
  it('le catalogue propose patch_note, et read_note sait lire une partie', async () => {
    backend.writeNote('v1', 'a', 'Plan.md', NOTE)
    const p = await ready()
    const r = await p.call<{ tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[] }>('v1', 'tools', 'list')
    const tools = r.body.result.tools
    expect(tools.map(t => t.name)).toContain('patch_note')
    expect(Object.keys(tools.find(t => t.name === 'read_note')!.inputSchema.properties)).toEqual(expect.arrayContaining(['section', 'lines', 'since', 'outline']))
  })

  it('lit une section, retouche un bloc par sa reference : une ecriture, puis la trace', async () => {
    backend.writeNote('v1', 'a', 'Plan.md', NOTE)
    const p = await ready()
    const read = await call(p, 'read_note', { path: 'Plan.md', section: 'MCP' })
    expect(read.text).toContain('section « Plan > MCP », lignes 5-7 sur 11')
    expect(read.text).not.toContain('La suite.')
    const ref = refIn(read.text, 'Le serveur')
    const r = await call(p, 'patch_note', {
      path: 'Plan.md',
      ops: [{ op: 'replace', ref, find: 'aux IA', text: 'à ChatGPT' }, { op: 'insert_after', ref, text: 'Il répond en JSON.' }],
      why: 'préciser',
    })
    expect(r.isError).toBe(false)
    expect(backend.text('v1', 'a')).toBe(NOTE.replace('Le serveur parle aux IA.', 'Le serveur parle à ChatGPT.\n\nIl répond en JSON.'))
    expect(backend.writes.map(w => [w.body.ticket, w.body.ops?.map(o => o.target)])).toEqual([['t1', ['document']], ['t1', ['index']]])
    expect(backend.reviewEntries('v1')).toMatchObject([{ kind: 'edit', docId: 'a', text: '2 retouches : préciser', author: { kind: 'agent', agentName: 'Secrétaire' } }])
    // La reponse donne les references d'apres : on continue sans relire.
    expect(r.text).toContain('Blocs écrits :')
    const next = [...r.text.matchAll(/‹([^›]+)› ligne/g)].at(-1)![1]!
    expect((await call(p, 'patch_note', { id: 'a', ops: [{ op: 'delete', ref: next }] })).isError).toBe(false)
    expect(backend.text('v1', 'a')).toBe(NOTE.replace('aux IA', 'à ChatGPT'))
  })

  it('since : le pair se souvient de ce que l agent a lu, d un appel a l autre', async () => {
    backend.writeNote('v1', 'a', 'Plan.md', NOTE)
    const p = await ready()
    const first = await call(p, 'read_note', { id: 'a' })
    const token = versionOf(first.text)
    // Une personne modifie la note dans son editeur.
    const t = ytext('a')
    t.insert(t.toString().indexOf('La suite.'), 'Vraiment ')
    const diff = await call(p, 'read_note', { id: 'a', since: token })
    expect(diff.text).toContain(`Depuis ${token} : 1 bloc(s) modifié(s), 0 ajouté(s), 0 supprimé(s).`)
    expect(diff.text).toContain('Vraiment La suite.')
    expect(diff.text).not.toContain('Introduction.')
    expect((await call(p, 'read_note', { id: 'a', since: 'last' })).text).toContain('Rien n’a changé depuis votre dernière lecture.')
    t.insert(t.length, '\n\nUn dernier mot.')
    const last = await call(p, 'read_note', { id: 'a', since: 'last' })
    expect(last.text).toContain('0 bloc(s) modifié(s), 1 ajouté(s), 0 supprimé(s)')
    expect(last.text).toContain('Un dernier mot.')
    // Jeton inconnu : dit, et le texte entier.
    const miss = await call(p, 'read_note', { id: 'a', since: 'vffffffffff' })
    expect(miss.isError).toBe(false)
    expect(miss.text).toContain('oubliée ou inconnue')
    expect(miss.text).toContain('Introduction.')
  })

  it('bloc modifie depuis la lecture : refuse, rend le texte d aujourd hui, rien n est ecrit', async () => {
    backend.writeNote('v1', 'a', 'Plan.md', NOTE)
    const p = await ready()
    const read = await call(p, 'read_note', { id: 'a' })
    const ref = refIn(read.text, 'Le serveur')
    const t = ytext('a')
    t.insert(t.toString().indexOf('aux IA'), 'surtout ')
    const r = await call(p, 'patch_note', { id: 'a', ops: [{ op: 'replace', ref, text: 'Texte de l’IA.' }] })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('Rien n’a été écrit')
    expect(r.text).toContain('Le serveur parle surtout aux IA.')
    expect(backend.writes).toEqual([])
    const again = await call(p, 'patch_note', { id: 'a', ops: [{ op: 'replace', ref: refIn(r.text, 'Le serveur'), text: 'Texte de l’IA.' }] })
    expect(again.isError).toBe(false)
    expect(backend.text('v1', 'a')).toContain('## MCP\n\nTexte de l’IA.\n\n## Suite')
  })

  it('effet de frappe : un long texte part en plusieurs ecritures, meme ticket, une seule trace', async () => {
    backend.writeNote('v1', 'a', 'Plan.md', NOTE)
    const p = await ready()
    const long = 'Voici un long paragraphe écrit par une IA, que les personnes qui ont la note ouverte doivent voir arriver petit à petit, mot après mot, sans attendre la fin.'
    // Ce que voient les editeurs ouverts : le texte apres chaque ecriture recue.
    const seen: string[] = []
    const t = ytext('a')
    t.observe(() => seen.push(t.toString()))
    const t0 = Date.now()
    const r = await call(p, 'patch_note', { id: 'a', ops: [{ op: 'insert_after', ref: '^intro', text: long }] })
    expect(r.isError).toBe(false)
    expect(Date.now() - t0).toBeLessThan(3000)
    expect(backend.text('v1', 'a')).toBe(NOTE.replace('Introduction. ^intro', `Introduction. ^intro\n\n${long}`))
    const writes = docWrites()
    expect(writes.length).toBeGreaterThan(3)
    expect(writes.length).toBeLessThanOrEqual(13)
    expect(new Set(backend.writes.map(w => w.body.ticket))).toEqual(new Set(['t1']))
    expect(backend.writes.every(w => w.status === 200)).toBe(true)
    // Chaque ecriture allonge le texte : il s'ecrit sous les yeux.
    expect(seen.length).toBe(writes.length)
    for (let i = 1; i < seen.length; i++) expect(seen[i]!.length).toBeGreaterThan(seen[i - 1]!.length)
    expect(seen[0]).toContain('Voici un long')
    expect(seen[0]).not.toContain('sans attendre la fin.')
    expect(backend.reviewEntries('v1').filter(e => e.kind === 'edit')).toHaveLength(1)
    // append et edit_note aussi.
    backend.writes.length = 0
    expect((await call(p, 'append', { id: 'a', text: long })).isError).toBe(false)
    expect(docWrites().length).toBeGreaterThan(3)
    expect(backend.text('v1', 'a').endsWith(`La suite.\n\n${long}`)).toBe(true)
  })

  it('une frappe d une autre personne pendant l effet de frappe ne casse rien', async () => {
    backend.writeNote('v1', 'a', 'Plan.md', NOTE)
    const p = await ready()
    const long = 'Voici un long paragraphe écrit par une IA, que les personnes qui ont la note ouverte doivent voir arriver petit à petit, mot après mot, sans attendre la fin.'
    const t = ytext('a')
    let typed = false
    t.observe(() => {
      // Apres la premiere ecriture du pair, Jean tape au debut de la note.
      if (typed) return
      typed = true
      setTimeout(() => t.insert(0, 'Jean : '), 0)
    })
    expect((await call(p, 'patch_note', { id: 'a', ops: [{ op: 'insert_after', ref: '^intro', text: long }] })).isError).toBe(false)
    expect(backend.text('v1', 'a')).toBe(`Jean : ${NOTE.replace('Introduction. ^intro', `Introduction. ^intro\n\n${long}`)}`)
  })

  it('ancre de l editeur : positions relatives Yjs, meme si la note a bouge ; secours par la citation', async () => {
    backend.writeNote('v1', 'a', 'Plan.md', NOTE)
    const p = await ready()
    const doc = backend.vaults.get('v1')!.docs.get('a')!.doc
    const t = ytext('a')
    // L'editeur ancre la selection « aux IA » (comme WP3 : Y.encodeRelativePosition, puis base64).
    const from = NOTE.indexOf('aux IA')
    const rel = (i: number, assoc: number) => b64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(t, i, assoc)))
    const anchor = { docId: 'a', start: rel(from, 0), end: rel(from + 6, -1), quote: 'aux IA', prefix: NOTE.slice(from - 32, from), suffix: NOTE.slice(from + 6, from + 38) }
    const cursor = { docId: 'a', start: rel(NOTE.length, 0), end: rel(NOTE.length, 0), quote: '', prefix: NOTE.slice(-32), suffix: '' }
    // Puis la note bouge : du texte avant, et une autre occurrence de la citation.
    t.insert(0, 'On parle aux IA ici aussi.\n\n')
    expect(Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(Buffer.from(anchor.start, 'base64')), doc)!.index).toBe(from + 28)
    const r = await call(p, 'patch_note', { ops: [{ op: 'replace', at: anchor, text: 'à Claude' }, { op: 'insert_after', at: cursor, text: ' Fin.' }] })
    expect(r.isError).toBe(false)
    expect(backend.text('v1', 'a')).toBe(`On parle aux IA ici aussi.\n\n${NOTE.replace('aux IA', 'à Claude')} Fin.`)
    expect(docWrites()).toHaveLength(1)

    // Positions illisibles : la citation, et son contexte pour choisir la bonne occurrence.
    const text = backend.text('v1', 'a')
    const at = text.indexOf('La suite.')
    const byQuote = { docId: 'a', start: 'pas-une-position', end: 'pas-une-position', quote: 'suite', prefix: text.slice(at - 10, at + 3), suffix: '.' }
    expect((await call(p, 'patch_note', { id: 'a', ops: [{ op: 'replace', at: byQuote, text: 'fin' }] })).isError).toBe(false)
    expect(backend.text('v1', 'a')).toContain('## Suite\n\nLa fin. Fin.')
    // Le passage n'existe plus : ancre perdue.
    const lost = await call(p, 'patch_note', { id: 'a', ops: [{ op: 'delete', at: { ...byQuote, quote: 'introuvable' } }] })
    expect(lost.isError).toBe(true)
    expect(lost.text).toContain('ancre perdue')
  })

  it('mode proposition : des suggestions ancrees, la note ne change pas', async () => {
    backend.writeNote('v1', 'a', 'Plan.md', NOTE)
    backend.tickets.set('t1', 'propose')
    const p = await ready()
    const read = await call(p, 'read_note', { id: 'a' }, 'propose')
    const r = await call(p, 'patch_note', {
      id: 'a',
      ops: [{ op: 'replace', ref: refIn(read.text, 'Le serveur'), text: 'Le serveur répond.' }, { op: 'delete', ref: '^intro', find: 'Introduction' }],
    }, 'propose')
    expect(r.isError).toBe(false)
    expect(r.text).toContain('2 proposition(s) déposée(s)')
    expect(backend.text('v1', 'a')).toBe(NOTE)
    expect(docWrites()).toEqual([])
    expect(backend.reviewEntries('v1').map(e => [e.kind, (e.anchor as { quote: string }).quote, e.replacement]).sort()).toEqual([
      ['suggestion', 'Introduction', ''],
      ['suggestion', 'Le serveur parle aux IA.', 'Le serveur répond.'],
    ])
  })
})
