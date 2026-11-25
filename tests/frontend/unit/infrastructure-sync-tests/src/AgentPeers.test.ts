// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Un agent IA present dans la note (ADR-033) : son etat d'awareness, pose par
// le serveur pour une IA externe ou par l'appli pour un agent d'ici, devient
// un pair avec un nom, une couleur, un etat et une position dans le texte.
import { describe, it, expect, vi, afterEach } from 'vitest'
import * as Y from 'yjs'
import { AGENT_SILENCE_MS, YjsCrdtAdapter } from '../../../../../packages/infrastructure-sync/src/YjsCrdtAdapter'

afterEach(() => { vi.useRealTimers() })

/** Les memes octets que le serveur (realtime/presence.rs) : un etat, un client. */
function serverAwareness(clientId: number, clock: number, state: unknown): Uint8Array {
  const out: number[] = []
  const varUint = (n: number) => {
    while (n > 0x7f) { out.push(0x80 | (n % 0x80)); n = Math.floor(n / 0x80) }
    out.push(n)
  }
  const json = new TextEncoder().encode(JSON.stringify(state))
  varUint(1); varUint(clientId); varUint(clock); varUint(json.length)
  return Uint8Array.from([...out, ...json])
}

function noteWith(text: string): YjsCrdtAdapter {
  const crdt = new YjsCrdtAdapter()
  crdt.sharedText().applyDelta([{ insert: text }])
  return crdt
}

/** Positions relatives de [from, to), comme le pair les calcule (textAnchor). */
function range(crdt: YjsCrdtAdapter, from: number, to: number) {
  const text = (crdt.rawDoc as Y.Doc).getText('codemirror')
  const rel = (i: number, assoc: number) => Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, i, assoc))
  return { anchor: rel(from, 0), head: rel(to, -1) }
}

const user = { name: 'Archiviste', color: '#00aa77', colorLight: '#00aa7733' }
const NOW = 1_795_000_000_000

describe('agents presents dans la note', () => {
  it('une IA externe qui ecrit : nom, couleur, etat, et le passage ecrit', () => {
    const crdt = noteWith('Bonjour tout le monde')
    const changes = vi.fn()
    crdt.onAgentPeersChange(changes)
    crdt.applyRemotePresence(serverAwareness(77, NOW, { user, agent: { id: 'a1', for: 'Jean' }, agentState: 'writing', cursor: range(crdt, 8, 21) }))
    expect(changes).toHaveBeenCalledTimes(1)
    expect(crdt.agentPeers()).toEqual([{ key: '77', name: 'Archiviste', color: '#00aa77', state: 'writing', from: 8, to: 21, onBehalfOf: 'Jean' }])
    // yCollab dessine le curseur comme celui d'une personne.
    expect(crdt.getRemoteCursorPositions()).toEqual([8, 21])
    // La personne tape avant : la position suit.
    crdt.sharedText().applyDelta([{ insert: 'Hier, ' }])
    expect(crdt.agentPeers()[0]).toMatchObject({ from: 14, to: 27 })
    crdt.dispose()
  })

  it('une IA qui lit : un passage, pas de curseur', () => {
    const crdt = noteWith('Bonjour le monde')
    crdt.applyRemotePresence(serverAwareness(77, NOW, { user, agent: { id: 'a1' }, agentState: 'reading', reading: range(crdt, 0, 16) }))
    expect(crdt.agentPeers()).toEqual([{ key: '77', name: 'Archiviste', color: '#00aa77', state: 'reading', from: 0, to: 16 }])
    expect(crdt.getRemoteCursorPositions()).toEqual([])
    crdt.dispose()
  })

  it('elle part : plus rien ; une personne n est jamais prise pour un agent', () => {
    const crdt = noteWith('Bonjour')
    const changes = vi.fn()
    crdt.onAgentPeersChange(changes)
    crdt.applyRemotePresence(serverAwareness(5, NOW, { user: { id: 'u2', color: 'hsl(5, 70%, 50%)' }, cursor: range(crdt, 0, 3) }))
    expect(crdt.agentPeers()).toEqual([])
    expect(changes).not.toHaveBeenCalled()
    crdt.applyRemotePresence(serverAwareness(77, NOW, { user, agentState: 'reading' }))
    // Sans position : l'etat seul.
    expect(crdt.agentPeers()).toEqual([{ key: '77', name: 'Archiviste', color: '#00aa77', state: 'reading' }])
    crdt.applyRemotePresence(serverAwareness(77, NOW + 1, null))
    expect(crdt.agentPeers()).toEqual([])
    expect(changes).toHaveBeenCalledTimes(2)
    // Une horloge qui recule est ignoree.
    crdt.applyRemotePresence(serverAwareness(77, NOW - 5, { user, agentState: 'writing' }))
    expect(crdt.agentPeers()).toEqual([])
    crdt.dispose()
  })

  it('un agent qui se tait est retire ici, sans attendre le serveur', () => {
    vi.useFakeTimers()
    const crdt = noteWith('Bonjour')
    const changes = vi.fn()
    crdt.onAgentPeersChange(changes)
    crdt.applyRemotePresence(serverAwareness(77, Date.now(), { user, agentState: 'writing', cursor: range(crdt, 0, 7) }))
    vi.advanceTimersByTime(AGENT_SILENCE_MS - 2000)
    // Une nouvelle de lui : le delai repart.
    crdt.applyRemotePresence(serverAwareness(77, Date.now(), { user, agentState: 'reading' }))
    vi.advanceTimersByTime(AGENT_SILENCE_MS - 2000)
    expect(crdt.agentPeers()).toHaveLength(1)
    vi.advanceTimersByTime(3000)
    expect(crdt.agentPeers()).toEqual([])
    expect(changes).toHaveBeenCalledTimes(3)
    crdt.dispose()
  })

  it('un agent de l appli : visible ici et chez les autres, depart compris', () => {
    const mine = noteWith('Bonjour tout le monde')
    const theirs = new YjsCrdtAdapter()
    theirs.applyRemoteOp(mine.getSnapshot())
    // Le meme fil que l'appli : CollabOrchestrator relaie la presence locale.
    const sent: Uint8Array[] = []
    mine.onLocalPresenceChanged(bytes => { sent.push(bytes); theirs.applyRemotePresence(bytes) })
    const agent = { id: 'a1', name: 'Correcteur', color: '#2563eb', onBehalfOf: 'Jean' }

    mine.setAgentPresence({ agent, activity: { state: 'writing', from: 8, to: 21 } })
    const expected = { name: 'Correcteur', color: '#2563eb', state: 'writing', from: 8, to: 21, onBehalfOf: 'Jean' }
    expect(mine.agentPeers()).toMatchObject([expected])
    expect(theirs.agentPeers()).toMatchObject([expected])
    // Le meme pair d'un signal a l'autre : un seul curseur.
    mine.setAgentPresence({ agent, activity: { state: 'reading', from: 0, to: 999 } })
    expect(theirs.agentPeers()).toMatchObject([{ state: 'reading', from: 0, to: 21 }])
    expect(theirs.agentPeers()[0]!.key).toBe(mine.agentPeers()[0]!.key)

    mine.setAgentPresence({ agent, activity: null })
    expect(mine.agentPeers()).toEqual([])
    expect(theirs.agentPeers()).toEqual([])
    expect(sent).toHaveLength(3)
    mine.dispose()
    theirs.dispose()
  })
})
