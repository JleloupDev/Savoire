// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Regression : une note ouverte ne montrait plus les ecritures des autres
// (une IA externe par le MCP, un autre onglet) apres une reconnexion de son
// hub. La connexion neuve n'etait plus dans le groupe du document : il
// fallait recharger la page. Le vrai client des hubs tourne ici, sur une
// fausse WebSocket qui joue le serveur (groupes par connexion, comme lui).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as Y from 'yjs'

vi.mock('@savoire/realtime-client', async () => await import('../../../../../packages/realtime-client/src/index'))

import { SignalRTransport, YjsCrdtAdapter } from '@savoire/infrastructure-sync'
import { CollabOrchestrator } from '@savoire/application'
import type { IIdentityProvider } from '@savoire/plugin-api'

const b64 = (u: Uint8Array): string => Buffer.from(u).toString('base64')

/** Le serveur : un journal par document, un groupe de connexions par document. */
const server = {
  sockets: [] as FakeSocket[],
  groups: new Map<string, Set<FakeSocket>>(),
  log: new Map<string, string[]>(),
  /** Refuse les nouvelles connexions (serveur arrete). */
  down: false,
  /** Une ecriture venue d'ailleurs (route interne du pair, autre client). */
  write(docId: string, update: Uint8Array): void {
    const op = b64(update)
    this.log.set(docId, [...(this.log.get(docId) ?? []), op])
    for (const s of this.groups.get(docId) ?? []) s.serverSend({ t: 'event', m: 'ReceiveOperation', a: [docId, 'agent:a1', op, { id: 'u', name: 'Jean', agentName: 'Archiviste' }] })
  },
  reset(): void {
    this.sockets = []
    this.groups.clear()
    this.log.clear()
    this.down = false
  },
}

class FakeSocket {
  onmessage: ((ev: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((ev: { code: number; reason: string }) => void) | null = null
  private open = true
  constructor(readonly url: string) {
    server.sockets.push(this)
    queueMicrotask(() => {
      if (server.down) { this.open = false; this.onerror?.(); return }
      this.serverSend({ t: 'hello', connectionId: `c${server.sockets.length}` })
    })
  }
  send(text: string): void {
    const f = JSON.parse(text) as { t: string; id?: string; m?: string; a?: unknown[] }
    if (f.t === 'ping') { this.serverSend({ t: 'pong' }); return }
    if (f.t !== 'invoke') return
    const [, docId, , op] = (f.a ?? []) as string[]
    if (f.m === 'JoinDocument') {
      const group = server.groups.get(docId!) ?? new Set()
      server.groups.set(docId!, group.add(this))
      this.serverSend({ t: 'event', m: 'InitDocument', a: [docId, server.log.get(docId!) ?? []] })
    }
    if (f.m === 'PushOperation') {
      server.log.set(docId!, [...(server.log.get(docId!) ?? []), op!])
      for (const s of server.groups.get(docId!) ?? []) if (s !== this) s.serverSend({ t: 'event', m: 'ReceiveOperation', a: [docId, 'c', op] })
    }
    if (f.id) this.serverSend({ t: 'result', id: f.id, r: null })
  }
  close(code = 1000): void { this.drop(code) }
  /** La connexion tombe (serveur redemarre, jeton expire, reseau) : le serveur l'oublie. */
  drop(code = 1006): void {
    if (!this.open) return
    this.open = false
    for (const g of server.groups.values()) g.delete(this)
    queueMicrotask(() => this.onclose?.({ code, reason: '' }))
  }
  serverSend(frame: unknown): void {
    if (this.open) this.onmessage?.({ data: JSON.stringify(frame) })
  }
}

const identity: IIdentityProvider = { init: async () => {}, getPublicKey: () => new Uint8Array(32), sign: async () => new Uint8Array(64) }

/** Une mise a jour Yjs qui ajoute `text` a la fin de la note, comme le pair l'ecrit. */
function appendUpdate(docId: string, text: string): Uint8Array {
  const doc = new Y.Doc()
  for (const op of server.log.get(docId) ?? []) Y.applyUpdate(doc, Buffer.from(op, 'base64'))
  const before = Y.encodeStateVector(doc)
  const t = doc.getText('codemirror')
  t.insert(t.length, text)
  return Y.encodeStateAsUpdate(doc, before)
}

function openNote() {
  const crdt = new YjsCrdtAdapter()
  const transport = new SignalRTransport({ serverUrl: 'http://srv', userId: 'u1', clientId: 'c1', getToken: () => 'tok' })
  const orchestrator = new CollabOrchestrator(crdt, transport, identity)
  const text = () => crdt.sharedText().toString()
  const close = async () => { orchestrator.dispose(); await transport.disconnect(); crdt.dispose() }
  return { crdt, transport, text, close }
}

const serverText = (docId: string): string => {
  const doc = new Y.Doc()
  for (const op of server.log.get(docId) ?? []) Y.applyUpdate(doc, Buffer.from(op, 'base64'))
  return doc.getText('codemirror').toString()
}

describe('SignalRTransport : la note ouverte reste abonnee apres une reconnexion', () => {
  beforeEach(() => {
    server.reset()
    vi.stubGlobal('WebSocket', FakeSocket)
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 200 }))
    vi.spyOn(console, 'debug').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('montre en direct l ecriture d une IA, avant comme apres une reconnexion', async () => {
    const note = openNote()
    await note.transport.join('v1', 'd1')
    expect(server.groups.get('d1')?.size).toBe(1)

    server.write('d1', appendUpdate('d1', 'Première insertion. '))
    expect(note.text()).toBe('Première insertion. ')

    // Le serveur redemarre (ou le jeton expire) : le client se reconnecte seul.
    server.sockets[0]!.drop()
    await vi.waitFor(() => expect(server.sockets).toHaveLength(2))
    await vi.waitFor(() => expect(note.transport.getState()).toBe('connected'))
    // La connexion neuve est rentree dans le document.
    await vi.waitFor(() => expect(server.groups.get('d1')?.has(server.sockets[1]!)).toBe(true))

    server.write('d1', appendUpdate('d1', 'Deuxième insertion.'))
    expect(note.text()).toBe('Première insertion. Deuxième insertion.')
    await note.close()
  })

  it('rattrape ce qui a ete ecrit pendant la coupure, et envoie ce qui a ete tape', async () => {
    const note = openNote()
    await note.transport.join('v1', 'd1')
    server.write('d1', appendUpdate('d1', 'Avant. '))

    server.down = true
    server.sockets[0]!.drop()
    await vi.waitFor(() => expect(note.transport.getState()).not.toBe('connected'))
    // Pendant la coupure : l'IA ecrit, la personne tape.
    server.write('d1', appendUpdate('d1', 'Pendant. '))
    note.crdt.sharedText().applyDelta([{ insert: 'Tapé. ' }])
    expect(note.text()).toBe('Tapé. Avant. ')

    server.down = false
    await vi.waitFor(() => expect(note.text()).toContain('Pendant. '), { timeout: 5000 })
    await vi.waitFor(() => expect(serverText('d1')).toContain('Tapé. '))
    expect(serverText('d1')).toBe(note.text())
    await note.close()
  })

  it('reessaie quand le hub a abandonne la reconnexion', async () => {
    vi.useFakeTimers()
    const note = openNote()
    await note.transport.join('v1', 'd1')
    server.down = true
    server.sockets[0]!.drop()
    // 0 s, 2 s, 10 s, 30 s : le hub abandonne.
    await vi.advanceTimersByTimeAsync(45_000)
    expect(note.transport.getState()).toBe('disconnected')
    const tried = server.sockets.length

    server.down = false
    await vi.advanceTimersByTimeAsync(31_000)
    expect(server.sockets.length).toBeGreaterThan(tried)
    expect(note.transport.getState()).toBe('connected')
    server.write('d1', appendUpdate('d1', 'Après le retour.'))
    expect(note.text()).toBe('Après le retour.')
    await note.close()
  })

  it('ne rentre plus dans un document ferme', async () => {
    const note = openNote()
    await note.transport.join('v1', 'd1')
    await note.close()
    await new Promise(r => setTimeout(r, 20))
    expect(server.sockets).toHaveLength(1)
    expect(server.groups.get('d1')?.size ?? 0).toBe(0)
  })
})
