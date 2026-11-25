// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup

import * as Y from 'yjs'
import {
  Awareness,
  encodeAwarenessUpdate,
  applyAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import type { Extension } from '@codemirror/state'
import type { AgentPeer, AgentPresenceInput, AiChangeInfo, AiChangeMetaInput, AiChangeRanges, AiChangeRecording, AiChangeWho, ICRDT } from '@savoire/plugin-api'
import type { ICollaborativeText, CrdtVersion } from '@savoire/domain-index'
import { YjsCollaborativeText } from './YjsCollaborativeText'
import { YjsSharedText } from './YjsSharedText'
import { YjsSharedTree } from './YjsSharedTree'
import { AiChangeTracker, aiChangeRanges, aiChangesMap, displayAiChanges, recordAiChange, undoAiChanges } from './AiChanges'


// Les commandes d'annulation de y-codemirror (seul son clavier est exporte).
type EditorView = Parameters<NonNullable<(typeof yUndoManagerKeymap)[number]['run']>>[0]
const Y_UNDO = yUndoManagerKeymap.find(k => k.key === 'Mod-z')!.run!
const Y_REDO = yUndoManagerKeymap.find(k => k.key === 'Mod-Shift-z')!.run!

// TypeScript 5.9 + moduleResolution:bundler fails to follow Yjs's .js→.d.ts
// re-export chain for advanced APIs. Cast once; runtime behaviour is validated
// by infrastructure-sync integration tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Y_ = Y as Record<string, any>

const REMOTE_ORIGIN = 'remote'

// ── Agents IA presents dans la note (ADR-033) ────────────────────────────────
//
// Un agent qui lit ou ecrit est un pair de plus dans l'awareness : son etat
// porte `agentState`, son nom et sa couleur dans `user`, et sa position en
// positions relatives de Yjs (`cursor` s'il ecrit : yCollab le dessine comme
// le curseur d'une personne ; `reading` s'il lit). Le serveur le pose pour
// une IA externe (realtime/presence.rs) ; l'appli le pose pour un agent qui
// tourne ici (setAgentPresence).

/** Origine des etats poses ici pour un agent : diffuses aux autres, retraits compris. */
const AGENT_ORIGIN = 'agent'
/**
 * Sans nouvelle d'un agent depuis ce delai, il est retire ici. Le serveur le
 * retire deja (10 s de silence) : ceci couvre un retrait perdu en route.
 */
export const AGENT_SILENCE_MS = 12_000
const AGENT_DEFAULT_COLOR = '#7c3aed'

interface AgentAwarenessState {
  user?: { name?: string; color?: string }
  agent?: { id?: string; for?: string }
  agentState?: string
  cursor?: { anchor?: unknown; head?: unknown }
  reading?: { anchor?: unknown; head?: unknown }
}

function isAgentState(s: unknown): s is AgentAwarenessState & { agentState: 'reading' | 'writing' } {
  const state = (s as AgentAwarenessState | null)?.agentState
  return state === 'reading' || state === 'writing'
}

/** Mise a jour d'awareness d'un seul client (format de y-protocols) ; etat null : il part. */
function encodeAwarenessState(clientId: number, clock: number, state: unknown): Uint8Array {
  const out: number[] = []
  const varUint = (n: number) => {
    while (n > 0x7f) { out.push(0x80 | (n % 0x80)); n = Math.floor(n / 0x80) }
    out.push(n)
  }
  const json = new TextEncoder().encode(JSON.stringify(state))
  varUint(1)
  varUint(clientId)
  varUint(clock)
  varUint(json.length)
  const bytes = new Uint8Array(out.length + json.length)
  bytes.set(out, 0)
  bytes.set(json, out.length)
  return bytes
}

/** ClientID d'un agent qui tourne ici : stable pour cet agent dans ce document ouvert, jamais 0. */
function agentClientId(agentId: string, localClientId: number): number {
  let h = 0x811c9dc5
  for (const c of `${agentId}\0${localClientId}`) {
    h ^= c.charCodeAt(0)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h || 1
}

/**
 * Deterministic color from a numeric seed. Keyed on the Yjs clientID (random
 * per Y.Doc instance) rather than the account userId — two tabs signed into
 * the SAME account are two distinct editing sessions and must still get
 * visibly different cursor colors, same as two different accounts would.
 */
function colorForClient(clientId: number): { color: string; colorLight: string } {
  const hue = clientId % 360
  return { color: `hsl(${hue}, 70%, 50%)`, colorLight: `hsla(${hue}, 70%, 50%, 0.3)` }
}

export class YjsCrdtAdapter implements ICRDT {
  private readonly ydoc: ReturnType<typeof Y_.Doc>
  private readonly ytext: ReturnType<typeof Y_.Text>
  private readonly awareness: Awareness
  private text: YjsSharedText | undefined
  private tree: YjsSharedTree | undefined
  /** Agents presents : clientID -> heure de leur derniere nouvelle. */
  private readonly agentSeen = new Map<number, number>()
  private readonly agentListeners = new Set<() => void>()
  private agentSweep: ReturnType<typeof setTimeout> | null = null
  private agentClock = 0

  constructor() {
    this.ydoc = new Y_.Doc()
    this.ytext = this.ydoc.getText('codemirror')
    this.awareness = new Awareness(this.ydoc)
    this.awareness.on('change', this.trackAgents)
  }

  // ── Agents IA presents ────────────────────────────────────────────────────

  private trackAgents = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }): void => {
    let touched = false
    const now = Date.now()
    for (const id of [...added, ...updated]) {
      if (id === this.ydoc.clientID) continue
      if (isAgentState(this.awareness.getStates().get(id))) {
        this.agentSeen.set(id, now)
        touched = true
      } else if (this.agentSeen.delete(id)) touched = true
    }
    for (const id of removed) if (this.agentSeen.delete(id)) touched = true
    if (!touched) return
    this.scheduleAgentSweep()
    for (const cb of [...this.agentListeners]) cb()
  }

  private scheduleAgentSweep(): void {
    if (this.agentSweep) clearTimeout(this.agentSweep)
    this.agentSweep = null
    if (this.agentSeen.size === 0) return
    const oldest = Math.min(...this.agentSeen.values())
    this.agentSweep = setTimeout(() => {
      this.agentSweep = null
      const limit = Date.now() - AGENT_SILENCE_MS
      const stale = [...this.agentSeen].filter(([, at]) => at <= limit).map(([id]) => id)
      // Origine « server » : un retrait local, pas a rediffuser.
      if (stale.length) removeAwarenessStates(this.awareness, stale, 'server')
      this.scheduleAgentSweep()
    }, Math.max(50, oldest + AGENT_SILENCE_MS - Date.now()))
  }

  private absolutePosition(rel: unknown): number | null {
    if (!rel || typeof rel !== 'object') return null
    try {
      const abs = Y_.createAbsolutePositionFromRelativePosition(Y_.createRelativePositionFromJSON(rel), this.ydoc)
      return abs && abs.type === this.ytext ? (abs.index as number) : null
    } catch {
      return null
    }
  }

  agentPeers(): AgentPeer[] {
    const peers: AgentPeer[] = []
    for (const [clientId, state] of this.awareness.getStates()) {
      if (clientId === this.ydoc.clientID || !isAgentState(state)) continue
      const range = state.agentState === 'writing' ? state.cursor : state.reading
      const a = this.absolutePosition(range?.anchor)
      const b = this.absolutePosition(range?.head)
      peers.push({
        key: String(clientId),
        name: state.user?.name || 'Agent',
        color: state.user?.color || AGENT_DEFAULT_COLOR,
        state: state.agentState,
        ...(a !== null && b !== null ? { from: Math.min(a, b), to: Math.max(a, b) } : {}),
        ...(state.agent?.for ? { onBehalfOf: state.agent.for } : {}),
      })
    }
    return peers
  }

  onAgentPeersChange(cb: () => void): () => void {
    this.agentListeners.add(cb)
    return () => { this.agentListeners.delete(cb) }
  }

  setAgentPresence({ agent, activity }: AgentPresenceInput): void {
    const clientId = agentClientId(agent.id, this.ydoc.clientID)
    // Horloge croissante : les autres ignorent une horloge qui recule.
    this.agentClock = Math.max(Date.now(), this.agentClock + 1)
    let state: (AgentAwarenessState & { user: { colorLight: string } }) | null = null
    if (activity) {
      const length = this.ytext.length as number
      const rel = (index: number, assoc: number): unknown =>
        Y_.relativePositionToJSON(Y_.createRelativePositionFromTypeIndex(this.ytext, Math.max(0, Math.min(length, index)), assoc))
      const range = activity.from !== undefined
        ? { anchor: rel(activity.from, 0), head: rel(activity.to ?? activity.from, -1) }
        : undefined
      state = {
        user: { name: agent.name, color: agent.color, colorLight: `${agent.color}33` },
        agent: { id: agent.id, ...(agent.onBehalfOf ? { for: agent.onBehalfOf } : {}) },
        agentState: activity.state,
        ...(range ? (activity.state === 'writing' ? { cursor: range } : { reading: range }) : {}),
      }
    }
    applyAwarenessUpdate(this.awareness, encodeAwarenessState(clientId, this.agentClock, state), AGENT_ORIGIN)
  }

  /**
   * Underlying Y.Doc, for wrapping by another CRDT port over the SAME document
   * (edgesync's YjsCrdt): two views, one state — the editor is untouched.
   */
  get rawDoc(): unknown {
    return this.ydoc
  }

  /**
   * Le texte du document, vu par le contrat ISharedText des plugins (sans
   * Yjs). Meme Y.Text que l'editeur. Cree au premier appel, puis le meme.
   */
  sharedText(): YjsSharedText {
    this.text ??= new YjsSharedText(this.ytext)
    return this.text
  }

  /** Le texte avec des positions relatives (ancres qui suivent les modifications). */
  collaborativeText(): YjsCollaborativeText {
    return new YjsCollaborativeText(this.ytext, this.ydoc)
  }

  /**
   * Le document vu comme un arbre JSON (contrat ISharedTree des plugins).
   * Meme Y.Doc, racine separee du texte. Cree au premier appel, puis le meme.
   */
  sharedTree(): YjsSharedTree {
    this.tree ??= new YjsSharedTree(this.ydoc)
    return this.tree
  }

  setLocalUser(cursorId: string): void {
    this.awareness.setLocalStateField('user', { id: cursorId, ...colorForClient(this.ydoc.clientID) })
  }

  onLocalOp(cb: (op: Uint8Array) => void): () => void {
    const handler = (update: Uint8Array, origin: unknown) => {
      if (origin !== REMOTE_ORIGIN) cb(update)
    }
    this.ydoc.on('update', handler)
    return () => this.ydoc.off('update', handler)
  }

  applyRemoteOp(op: Uint8Array): void {
    Y_.applyUpdate(this.ydoc, op, REMOTE_ORIGIN)
  }

  getSnapshot(): Uint8Array {
    return Y_.encodeStateAsUpdate(this.ydoc) as Uint8Array
  }

  encodeLocalPresence(changedClients: number[]): Uint8Array {
    return encodeAwarenessUpdate(this.awareness, changedClients)
  }

  applyRemotePresence(bytes: Uint8Array): void {
    applyAwarenessUpdate(this.awareness, bytes, 'server')
  }

  getRemoteCursorPositions(): number[] {
    const positions: number[] = []
    for (const [clientId, state] of this.awareness.getStates()) {
      if (clientId === this.ydoc.clientID) continue
      const cursor = (state as { cursor?: { anchor?: unknown; head?: unknown } })?.cursor
      if (!cursor) continue
      const anchorAbs = Y_.createAbsolutePositionFromRelativePosition(cursor.anchor, this.ydoc)
      const headAbs = Y_.createAbsolutePositionFromRelativePosition(cursor.head, this.ydoc)
      if (anchorAbs !== null) positions.push(anchorAbs.index)
      if (headAbs !== null) positions.push(headAbs.index)
    }
    return positions
  }

  onLocalPresenceChanged(
    cb: (bytes: Uint8Array, changedClients: number[]) => void,
  ): () => void {
    const handler = (
      { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ) => {
      if (origin === 'server') return
      // Un agent pose ici qui part : son depart se dit aussi aux autres.
      const changed = [...added, ...updated, ...(origin === AGENT_ORIGIN ? removed : [])]
      if (changed.length > 0) cb(encodeAwarenessUpdate(this.awareness, changed), changed)
    }
    this.awareness.on('change', handler)
    return () => this.awareness.off('change', handler)
  }

  onTextChange(cb: (text: ICollaborativeText, version?: CrdtVersion) => void): () => void {
    const handler = () => {
      cb(new YjsCollaborativeText(this.ytext, this.ydoc), this.getVersion())
    }
    this.ydoc.on('update', handler)
    return () => this.ydoc.off('update', handler)
  }

  getVersion(): CrdtVersion {
    let clock = 0
    for (const c of (Y_.decodeStateVector(Y_.encodeStateVector(this.ydoc)) as Map<number, number>).values()) clock += c
    return { clock }
  }

  getExtensions(): Extension[] {
    return [yCollab(this.ytext, this.awareness)]
  }

  /** Annule les modifications faites ici seulement (Y.UndoManager de yCollab). */
  undo(view: EditorView): boolean {
    return Y_UNDO(view)
  }

  redo(view: EditorView): boolean {
    return Y_REDO(view)
  }

  // ── Modifications de l'IA (AiChanges.ts) ─────────────────────────────────

  aiChanges(): AiChangeInfo[] {
    return displayAiChanges(this.ydoc)
  }

  onAiChangesChange(cb: (added: string[]) => void): () => void {
    const map = aiChangesMap(this.ydoc)
    const handler = (event: { keysChanged: Set<string>; changes: { keys: Map<string, { action: string }> } }): void => {
      const added = [...event.changes.keys].filter(([, c]) => c.action === 'add').map(([k]) => k)
      cb(added)
    }
    map.observe(handler as never)
    return () => map.unobserve(handler as never)
  }

  aiChangeRanges(parts: readonly string[]): AiChangeRanges {
    return aiChangeRanges(this.ydoc, this.ytext, parts)
  }

  undoAiChange(parts: readonly string[], by: AiChangeWho): { ok: boolean; partial: boolean } {
    return undoAiChanges(this.ydoc, this.ytext, parts, by)
  }

  beginAiChange(meta: AiChangeMetaInput): AiChangeRecording {
    const tracker = new AiChangeTracker(this.ytext)
    let done = false
    return {
      capture: fn => tracker.capture(fn),
      commit: () => {
        if (done) return null
        done = true
        return recordAiChange(this.ydoc, tracker.ops, meta)
      },
    }
  }

  dispose(): void {
    this.text?.dispose()
    if (this.agentSweep) clearTimeout(this.agentSweep)
    this.agentListeners.clear()
    removeAwarenessStates(this.awareness, [this.ydoc.clientID], 'local')
    this.awareness.destroy()
    this.ydoc.destroy()
  }
}
