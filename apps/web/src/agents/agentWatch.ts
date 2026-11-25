// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Agents en veille sur la note ouverte (ADR-033, agent-core/watch.ts), dans
// l'appli, avec l'IA de la personne.
//
//  - On allume la veille d'un agent dans le panneau Agents ; ce choix reste
//    sur ce poste. Un agent ne veille que dans les vaults qui lui sont permis.
//  - L'agent relit les blocs de la note active (liveBlocks) apres chaque
//    pause de frappe.
//  - Ses fautes deviennent des suggestions dans la Revision, a son nom
//    (« Relecteur (IA), pour Jean ») : jamais d'ecriture directe. Il faut le
//    droit « modifier » (proposition) et pouvoir ecrire dans le vault.
//  - Ses conseils s'affichent dans la marge, a cote du bloc, et s'effacent si
//    le bloc change. « Garder » en fait un commentaire (droit « commenter »).
//  - Marges : un trait discret sur les blocs a relire, un trait anime sur
//    celui qu'il lit (desactivable).
//  - Sa consommation compte dans son budget (tokens par jour).
//  - Il ne relit pas le paragraphe ou la personne tape : il attend qu'elle
//    ait fini (8 s sans frappe), comme les outils d'ecriture.
import {
  BlockWatcher, TYPING_GUARD_MS, typingZone, type WatchMemory, type WatchMemoryStore, type WatchReply, type WatchReview, type WatchStatus,
} from '@savoire/agent-core'
import { reviewFor } from '../reviewProposals'
import type { AgentDefinition, NoteBlock, ToolActor } from '@savoire/plugin-api'
import type { BlockMark } from '@savoire/editor-core'
import { notify } from '@savoire/notifications'
import type { EditorAreaRefs } from '../EditorAreaWidget'
import { aiService } from '../aiService'
import { typingSpot } from '../aiContext'
import { liveBlocks, type BlocksSnapshot } from '../liveBlocks'
import { agentDirectory, onAgentDirectoryChange, usedToday } from './agentDirectory'
import { AppToolHost } from './appToolHost'
import { assertAgentUsable } from './agentRunner'

const MEMORY_PREFIX = 'savoire-watch:'
const MEMORY_INDEX = 'savoire-watch-index'
const MAX_MEMORY_NOTES = 200
const MAX_MEMORY_BLOCKS = 2000
const MARKS_KEY = 'savoire-watch-marks'
/** La consommation est remontee par lots (une « execution » par lot). */
const USAGE_BATCH = 5

function storage(): Storage | null {
  try { return window.localStorage } catch { return null }
}

/** Memoire de la veille, sur ce poste : par agent, vault et note. */
export const localWatchMemory: WatchMemoryStore = {
  load(agentId, vaultId, docId) {
    const raw = storage()?.getItem(`${MEMORY_PREFIX}${agentId}:${vaultId}:${docId}`)
    if (!raw) return { seen: new Map(), remarks: [] }
    try {
      const v = JSON.parse(raw) as { s?: [string, string][]; r?: string[]; d?: string[]; c?: string[] }
      return {
        seen: new Map(Array.isArray(v.s) ? v.s : []), remarks: Array.isArray(v.r) ? v.r : [],
        ...(Array.isArray(v.d) ? { dismissed: v.d } : {}), ...(Array.isArray(v.c) ? { context: v.c } : {}),
      }
    } catch { return { seen: new Map(), remarks: [] } }
  },
  save(agentId, vaultId, docId, memory: WatchMemory) {
    const s = storage()
    if (!s) return
    const key = `${MEMORY_PREFIX}${agentId}:${vaultId}:${docId}`
    let index: string[] = []
    try { index = JSON.parse(s.getItem(MEMORY_INDEX) ?? '[]') as string[] } catch { index = [] }
    index = [...index.filter(k => k !== key), key]
    while (index.length > MAX_MEMORY_NOTES) s.removeItem(index.shift()!)
    try {
      s.setItem(key, JSON.stringify({
        s: [...memory.seen].slice(-MAX_MEMORY_BLOCKS), r: memory.remarks,
        ...(memory.dismissed?.length ? { d: memory.dismissed } : {}), ...(memory.context?.length ? { c: memory.context } : {}),
      }))
      s.setItem(MEMORY_INDEX, JSON.stringify(index))
    } catch { /* stockage plein : la veille relira */ }
  },
}

export function watchMarksEnabled(): boolean {
  return storage()?.getItem(MARKS_KEY) !== 'off'
}

interface Watch {
  agent: AgentDefinition
  watcher: BlockWatcher
  status: WatchStatus
  /** Conseils a l'ecran : empreinte du bloc -> texte. */
  advice: Map<string, string>
  /** Accord demande pour un gros collage. */
  asking: ((ok: boolean) => void) | null
  /** Tokens estimes pour ce gros collage. */
  askEstimate: number
  spentToday: number
  pendingUsage: { inputTokens: number; outputTokens: number; n: number }
}

class AgentWatchService {
  private refs: EditorAreaRefs | null = null
  private agents: AgentDefinition[] = []
  private readonly watches = new Map<string, Watch>()
  private readonly listeners = new Set<() => void>()

  /** Ouvre le panneau Agents (clic sur le robot de la note). */
  private openPanel: () => void = () => {}

  start(refs: EditorAreaRefs, openPanel?: () => void): void {
    if (this.refs) return
    this.refs = refs
    if (openPanel) this.openPanel = openPanel
    const load = () => {
      void agentDirectory()?.list().then(list => { this.agents = list; this.sync() }, () => {})
    }
    load()
    onAgentDirectoryChange(load)
    liveBlocks.onSwitch(snap => {
      // Autre vault, autre compte : les veilles permises ne sont plus les memes.
      const key = `${this.userId()}|${this.refs?.selectedVault.current?.id ?? ''}`
      if (key !== this.placed) { this.placed = key; this.sync(); return }
      this.updateAll(snap)
    })
    liveBlocks.onStable(snap => this.updateAll(snap))
  }

  /** Compte et vault des veilles en place. */
  private placed = ''

  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  private changed(): void {
    for (const cb of [...this.listeners]) cb()
  }

  private userId(): string {
    return this.refs?.activeAccount.current?.userId ?? ''
  }

  /** Agents en veille choisis sur ce poste. */
  private chosen(): Set<string> {
    try { return new Set(JSON.parse(storage()?.getItem(`savoire-watching:${this.userId()}`) ?? '[]') as string[]) } catch { return new Set() }
  }

  private saveChosen(ids: Set<string>): void {
    storage()?.setItem(`savoire-watching:${this.userId()}`, JSON.stringify([...ids]))
  }

  isWatching(agentId: string): boolean {
    return this.watches.has(agentId)
  }

  status(agentId: string): WatchStatus | null {
    return this.watches.get(agentId)?.status ?? null
  }

  /** Tokens estimes du gros collage en attente d'accord. */
  askEstimate(agentId: string): number {
    return this.watches.get(agentId)?.askEstimate ?? 0
  }

  /** Allume ou eteint la veille d'un agent. */
  toggle(agent: AgentDefinition): void {
    const ids = this.chosen()
    if (ids.has(agent.id)) ids.delete(agent.id)
    else ids.add(agent.id)
    this.saveChosen(ids)
    if (!this.agents.some(a => a.id === agent.id)) this.agents = [...this.agents, agent]
    this.sync()
  }

  /** L'agent oublie ce qu'il a lu de la note active : il relit tout. */
  forget(agentId: string): void {
    this.watches.get(agentId)?.watcher.forget()
  }

  /** Un agent en veille lit en ce moment (pour le panneau). */
  anyWatching(): { agent: AgentDefinition; status: WatchStatus }[] {
    return [...this.watches.values()].map(w => ({ agent: w.agent, status: w.status }))
  }

  /** Le contexte donne pour la note active. */
  context(agentId: string): string[] {
    return this.watches.get(agentId)?.watcher.context() ?? []
  }

  /** Ajoute du contexte pour la note active, sans arreter la veille. */
  addContext(agentId: string, text: string): boolean {
    const w = this.watches.get(agentId)
    if (!w || !w.status.docId) return false
    w.watcher.addContext(text)
    return true
  }

  removeContext(agentId: string, index: number): void {
    this.watches.get(agentId)?.watcher.removeContext(index)
  }

  /** Repond a la question du gros collage. */
  answer(agentId: string, ok: boolean): void {
    const w = this.watches.get(agentId)
    const resolve = w?.asking
    if (!w || !resolve) return
    w.asking = null
    resolve(ok)
  }

  /** Les veilles suivent les agents choisis et le vault ouvert. */
  sync(): void {
    const vaultId = this.refs?.selectedVault.current?.id
    const ids = this.chosen()
    for (const [id, w] of this.watches) {
      const agent = this.agents.find(a => a.id === id)
      // Agent retire, eteint, modifie : la veille repart de sa nouvelle definition.
      let usable = true
      if (agent && vaultId) {
        try { assertAgentUsable(agent, vaultId) } catch { usable = false }
      }
      if (!agent || !usable || !ids.has(id) || agent.updatedAt !== w.agent.updatedAt) this.drop(id)
    }
    for (const id of ids) {
      if (this.watches.has(id)) continue
      const agent = this.agents.find(a => a.id === id)
      if (!agent) continue
      if (vaultId) {
        try { assertAgentUsable(agent, vaultId) } catch { continue }
      }
      this.watches.set(id, this.create(agent))
    }
    this.updateAll(liveBlocks.current())
    this.changed()
  }

  private drop(id: string): void {
    const w = this.watches.get(id)
    if (!w) return
    w.asking?.(false)
    w.watcher.stop()
    this.flushUsage(w)
    liveBlocks.setMarks(`watch:${id}`, [])
    liveBlocks.setPresence(`watch:${id}`, null)
    this.watches.delete(id)
  }

  private create(agent: AgentDefinition): Watch {
    const w: Watch = {
      agent, advice: new Map(), asking: null, askEstimate: 0, spentToday: 0,
      pendingUsage: { inputTokens: 0, outputTokens: 0, n: 0 },
      status: { docId: null, blocks: new Map(), asking: 0, reading: 0, pending: 0 },
      watcher: null as unknown as BlockWatcher,
    }
    void usedToday(agent.id).then(n => { w.spentToday += n }, () => {})
    w.watcher = new BlockWatcher({
      agent,
      memory: localWatchMemory,
      chat: req => {
        if (!aiService.connections().length) return Promise.reject(Object.assign(new Error('Aucune IA configurée : ajoutez une connexion dans Paramètres → IA.'), { fatal: true }))
        return aiService.chat(req, agent.connectionId)
      },
      canSpend: () => {
        const max = agent.budget?.maxTokensPerDay
        return max && w.spentToday >= max ? `Budget du jour atteint (${max.toLocaleString('fr-FR')} tokens).` : null
      },
      onUsage: u => {
        w.spentToday += u.inputTokens + u.outputTokens
        w.pendingUsage.inputTokens += u.inputTokens
        w.pendingUsage.outputTokens += u.outputTokens
        if (++w.pendingUsage.n >= USAGE_BATCH) this.flushUsage(w)
      },
      onFinding: (note, block, reply) => { void this.apply(w, note, block, reply).catch(() => {}) },
      onState: status => {
        const hadError = w.status.error
        w.status = status
        if (status.error && !hadError) notify('danger', `Veille de ${agent.name} arrêtée`, status.error)
        this.paint(w)
        this.changed()
      },
      reviews: note => this.reviews(agent, note.docId),
      // Le paragraphe ou la personne tape attend qu'elle ait fini.
      typing: note => {
        const spot = typingSpot(note.docId)
        if (!spot) return null
        const zone = note.blocks.some(b => b.hash === spot.blockHash) ? null : typingZone(note.text, spot)
        const hash = zone ? note.blocks.find(b => b.from === zone.from)?.hash : spot.blockHash
        return hash ? { blockHash: hash, freeInMs: TYPING_GUARD_MS - spot.ageMs } : null
      },
      askLarge: (_count, estimated) => new Promise<boolean>(resolve => {
        w.asking = resolve
        w.askEstimate = estimated
        this.paint(w)
        this.changed()
      }),
    })
    return w
  }

  private flushUsage(w: Watch): void {
    const u = w.pendingUsage
    if (!u.n) return
    w.pendingUsage = { inputTokens: 0, outputTokens: 0, n: 0 }
    void agentDirectory()?.reportUsage(w.agent.id, { inputTokens: u.inputTokens, outputTokens: u.outputTokens, calls: 0 }).catch(() => {})
  }

  private updateAll(snap: BlocksSnapshot | null): void {
    const vaultId = this.refs?.selectedVault.current?.id
    for (const w of this.watches.values()) {
      // Conseils d'une autre note, ou de blocs qui ont change : effaces.
      if (!snap || snap.docId !== w.status.docId) w.advice.clear()
      else {
        const present = new Set(snap.blocks.map(b => b.hash))
        for (const h of [...w.advice.keys()]) if (!present.has(h)) w.advice.delete(h)
      }
      const usable = !!snap && (!vaultId || vaultId === snap.vaultId)
      w.watcher.update(usable ? snap : null, liveBlocks.visibleRange())
    }
  }

  /** Les revisions de la note (suggestions, commentaires), avec leur statut : l'agent ne repropose pas. */
  private reviews(agent: AgentDefinition, docId: string): WatchReview[] {
    const session = this.refs?.vaultSession.current
    if (!session) return []
    try {
      return reviewFor(session).threads(docId).flatMap(t => {
        const r = t.root
        if (r.kind !== 'suggestion' && r.kind !== 'comment') return []
        const author = r.author as { kind?: string; agentId?: string }
        return [{
          kind: r.kind, status: r.status ?? 'open', quote: r.anchor?.quote ?? '',
          ...(r.replacement !== undefined ? { replacement: r.replacement } : {}),
          ...(r.text ? { text: r.text } : {}),
          ...(author.kind === 'agent' && author.agentId === agent.id ? { mine: true } : {}),
        }]
      })
    } catch { return [] }
  }

  private actor(agent: AgentDefinition): ToolActor | null {
    const account = this.refs?.activeAccount.current
    if (!account) return null
    return { agentId: agent.id, agentName: agent.name, onBehalfOf: { userId: account.userId, displayName: account.displayName || account.userId } }
  }

  private canWrite(): boolean {
    const refs = this.refs
    return !!refs && !refs.isReadOnly.current && refs.selectedVault.current?.role !== 'viewer'
  }

  private host(): AppToolHost | null {
    const refs = this.refs
    const client = refs?.vaultAPI.current
    const session = refs?.vaultSession.current
    if (!refs || !client || !session) return null
    return new AppToolHost({ client, session, api: refs.pluginAPI.current as never })
  }

  /** Une trouvaille : fautes en suggestions, conseil dans la marge. */
  private async apply(w: Watch, note: BlocksSnapshot, block: NoteBlock, reply: WatchReply): Promise<void> {
    const perms = w.agent.permissions
    const actor = this.actor(w.agent)
    if (reply.faults.length && perms.edit && perms.edit !== 'deny' && this.canWrite() && actor) {
      const host = this.host()
      // Le texte a pu bouger depuis : le bloc est retrouve par son empreinte.
      const now = liveBlocks.current()
      const at = now?.docId === note.docId ? now.blocks.find(b => b.hash === block.hash) : undefined
      if (host && at) {
        for (const f of reply.faults) {
          const i = at.text.indexOf(f.find)
          if (i < 0) continue
          try {
            await host.suggest(note.docId, at.from + i, at.from + i + f.find.length, f.replace, actor, f.why || 'Correction')
          } catch { /* note fermee ou en lecture seule : on passe */ }
        }
      }
    }
    if (reply.advice) {
      w.advice.set(block.hash, reply.advice)
      this.paint(w)
    }
  }

  private async keep(w: Watch, hash: string): Promise<void> {
    const text = w.advice.get(hash)
    const actor = this.actor(w.agent)
    const host = this.host()
    const now = liveBlocks.current()
    const at = now?.blocks.find(b => b.hash === hash)
    if (!text || !actor || !host || !now || !at) return
    try {
      await host.comment(now.docId, text, actor, { from: at.from, to: at.to })
      w.advice.delete(hash)
      this.paint(w)
    } catch (err) {
      notify('danger', 'Commentaire impossible', err instanceof Error ? err.message : String(err))
    }
  }

  /** Les marques de la veille dans l'editeur actif. */
  private paint(w: Watch): void {
    const snap = liveBlocks.current()
    const owner = `watch:${w.agent.id}`
    if (!snap || snap.docId !== w.status.docId || w.status.error) {
      liveBlocks.setMarks(owner, [])
      liveBlocks.setPresence(owner, null)
      return
    }
    // Le robot de la note : il lit, ou il attend la prochaine pause de frappe.
    const st = w.status
    liveBlocks.setPresence(owner, {
      label: w.agent.name,
      busy: st.reading > 0,
      title: st.reading > 0
        ? `${w.agent.name} relit ${st.reading} passage(s)${st.pending ? `, ${st.pending} en attente` : ''}`
        : st.asking ? `${w.agent.name} attend votre accord pour relire ${st.asking} passages`
          : st.pending ? `${w.agent.name} : ${st.pending} passage(s) en attente`
            : `${w.agent.name} veille sur la note (cliquer : panneau Agents)`,
      onClick: () => this.openPanel(),
    })
    const name = w.agent.name
    const marks: BlockMark[] = []
    const states = watchMarksEnabled() ? w.status.blocks : new Map()
    const canKeep = !!w.agent.permissions.comment && w.agent.permissions.comment !== 'deny' && this.canWrite()
    for (const b of snap.blocks) {
      const advice = w.advice.get(b.hash)
      const state = states.get(b.hash)
      if (advice) {
        marks.push({
          from: b.from, to: b.to, className: 'cm-block-watch-advice',
          badge: {
            label: '💡', className: 'cm-block-badge-advice', text: `${name} : ${advice}`,
            actions: [
              ...(canKeep ? [{ label: 'Garder', run: () => { void this.keep(w, b.hash) } }] : []),
              // Ecarte : il ne sera plus donne sur cette note.
              { label: 'Ignorer', run: () => { w.watcher.dismissAdvice(advice); w.advice.delete(b.hash); this.paint(w) } },
            ],
          },
        })
      } else if (state === 'reading') {
        marks.push({ from: b.from, to: b.to, className: 'cm-block-watch-reading', title: `${name} relit ce passage…` })
      } else if (state === 'pending') {
        marks.push({ from: b.from, to: b.to, className: 'cm-block-watch-pending', title: `${name} va relire ce passage` })
      }
    }
    if (w.asking && w.status.asking) {
      const first = snap.blocks.find(b => b.kind !== 'frontmatter')
      if (first) {
        marks.push({
          from: first.from, to: first.from, className: 'cm-block-watch-ask',
          badge: {
            label: `👁 ${w.status.asking}`, className: 'cm-block-badge-ask',
            text: `${name} : relire les ${w.status.asking} passages nouveaux de la note ? Environ ${w.askEstimate.toLocaleString('fr-FR')} tokens.`,
            actions: [
              { label: 'Relire', run: () => this.answer(w.agent.id, true) },
              { label: 'Passer', run: () => this.answer(w.agent.id, false) },
            ],
          },
        })
      }
    }
    liveBlocks.setMarks(owner, marks)
  }

  /** Allume ou eteint les traits d'etat dans la marge. */
  setMarksEnabled(on: boolean): void {
    storage()?.setItem(MARKS_KEY, on ? 'on' : 'off')
    for (const w of this.watches.values()) this.paint(w)
  }
}

export const agentWatch = new AgentWatchService()

// Etat de toute la session (editeur actif, abonnements, veilles) : un
// remplacement a chaud (Vite) en ferait un second exemplaire, jamais branche.
// Modifie pendant le developpement : on recharge la page.
if (import.meta.hot) import.meta.hot.accept(() => { window.location.reload() })

/** Branche la veille des agents (une fois, au demarrage). */
export function startAgentWatch(refs: EditorAreaRefs, openPanel?: () => void): void {
  agentWatch.start(refs, openPanel)
}
