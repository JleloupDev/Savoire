// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Un agent IA dans la note, en direct (ADR-033). Quand une IA lit ou ecrit
// (ChatGPT par le serveur, ou un agent de l'appli), elle est un pair de plus
// dans la note :
//  - elle ecrit : une etiquette a son nom, la ou elle ecrit (le curseur et le
//    passage colore sont dessines par yCollab, comme pour une personne), et
//    un trait dans la marge, le long de ce qu'elle vient d'ecrire ;
//  - elle lit : un trait leger dans la marge, le long du passage lu ;
//  - en bas a droite, le robot dit « Archiviste lit… » ou « ecrit… », avec un
//    bouton « Suivre » : la vue suit alors l'endroit ou l'agent travaille.
//
// Rien ne s'affiche quand aucun agent ne travaille. La source (le CRDT du
// document) dit qui est la ; elle retire elle-meme un agent qui se tait.
//
// Le trait et le robot reprennent BlockMarks et AgentPresence. La marge a une
// case par widget : en modes « power » et « classique », un paragraphe rendu
// cache le curseur et l'etiquette, comme ceux d'une personne ; le trait, lui,
// reste et dit ou l'agent travaille.

import { StateEffect, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import type { AgentPeer } from '@savoire/plugin-api'
import { applyAgentPresence } from './AgentPresence'
import { applyBlockMarks } from './BlockMarks'

/** Qui est dans la note (YjsCrdtAdapter.agentPeers / onAgentPeersChange). */
export interface AgentCursorSource {
  list(): AgentPeer[]
  subscribe(cb: () => void): () => void
}

/** Le choix « suivre l'agent », garde d'une note a l'autre. */
export interface AgentFollowStore {
  get(): boolean
  set(on: boolean): void
}

const FOLLOW_KEY = 'savoire-agent-follow'

/** Garde sur l'appareil : l'agent ne reste que quelques secondes, on ne recoche pas a chaque fois. */
export const agentFollow: AgentFollowStore = {
  get() {
    try { return globalThis.localStorage?.getItem(FOLLOW_KEY) === '1' } catch { return false }
  },
  set(on) {
    try {
      if (on) globalThis.localStorage?.setItem(FOLLOW_KEY, '1')
      else globalThis.localStorage?.removeItem(FOLLOW_KEY)
    } catch { /* stockage indisponible : le choix vaut pour cette fois */ }
  },
}

const ACTIVITY: Record<AgentPeer['state'], string> = { reading: 'lit', writing: 'écrit' }

/** Source de marques et de robot d'un agent (une par agent present). */
const ownerOf = (p: AgentPeer): string => `agent-live:${p.key}`

/** Ou l'agent travaille : la fin de ce qu'il ecrit, le debut de ce qu'il lit. */
function workingAt(p: AgentPeer): number | undefined {
  return p.state === 'writing' ? p.to : p.from
}

class AgentTagWidget extends WidgetType {
  constructor(private readonly text: string, private readonly color: string) { super() }

  toDOM(): HTMLElement {
    const anchor = document.createElement('span')
    anchor.className = 'cm-agent-tag-anchor'
    anchor.setAttribute('aria-hidden', 'true')
    const tag = document.createElement('span')
    tag.className = 'cm-agent-tag'
    tag.setAttribute('data-testid', 'agent-tag')
    tag.style.backgroundColor = this.color
    tag.textContent = this.text
    anchor.appendChild(tag)
    return anchor
  }

  eq(other: AgentTagWidget): boolean {
    return other.text === this.text && other.color === this.color
  }

  ignoreEvent(): boolean {
    return true
  }
}

const refresh = StateEffect.define<null>()

export function agentCursorsExtension(source: AgentCursorSource, follow: AgentFollowStore = agentFollow): Extension {
  class AgentCursorsView {
    decorations: DecorationSet = Decoration.none
    private peers: AgentPeer[] = []
    /** Sources posees (robot, marques) : a retirer quand l'agent part. */
    private shown = new Set<string>()
    private followed = ''
    private pending = false
    private destroyed = false
    private readonly unsubscribe: () => void

    constructor(private readonly view: EditorView) {
      this.unsubscribe = source.subscribe(() => this.schedule())
      // Un agent deja la a l'ouverture de la note.
      if (source.list().length) this.schedule()
    }

    /** Jamais pendant une mise a jour de CodeMirror : on attend la fin du tour. */
    private schedule(): void {
      if (this.pending || this.destroyed) return
      this.pending = true
      queueMicrotask(() => {
        this.pending = false
        if (!this.destroyed) this.sync()
      })
    }

    private sync(): void {
      const view = this.view
      this.peers = source.list()
      const now = new Set<string>()
      for (const p of this.peers) {
        const owner = ownerOf(p)
        now.add(owner)
        const on = follow.get()
        applyAgentPresence(view, owner, {
          label: p.name,
          busy: true,
          activity: ACTIVITY[p.state],
          color: p.color,
          title: p.onBehalfOf ? `${p.name} (IA), pour ${p.onBehalfOf}` : `${p.name} (IA)`,
          action: {
            label: on ? 'Suivi' : 'Suivre',
            title: on ? 'Ne plus suivre l’agent' : 'Faire suivre la vue là où l’agent travaille',
            active: on,
            onClick: () => { follow.set(!follow.get()); this.followed = ''; this.schedule() },
          },
        })
        applyBlockMarks(view, owner, p.from !== undefined && p.to !== undefined
          ? [p.state === 'reading'
              ? { from: p.from, to: p.to, className: 'cm-block-agent-reading', title: `${p.name} lit ce passage…`, color: p.color }
              : { from: p.from, to: p.to, className: 'cm-block-agent-writing', title: `${p.name} écrit ici…`, color: p.color }]
          : [])
      }
      for (const owner of this.shown) {
        if (now.has(owner)) continue
        applyAgentPresence(view, owner, null)
        applyBlockMarks(view, owner, [])
      }
      this.shown = now

      // Suivre : seulement quand l'agent a bouge, pas a chaque frappe de la personne.
      const effects: StateEffect<unknown>[] = [refresh.of(null)]
      const target = follow.get() ? this.peers.find(p => workingAt(p) !== undefined) : undefined
      const at = target ? workingAt(target)! : -1
      const key = target ? `${target.key}:${target.state}:${at}` : ''
      if (target && key !== this.followed) {
        effects.push(EditorView.scrollIntoView(Math.min(at, view.state.doc.length), { y: 'center' }))
      }
      this.followed = key
      view.dispatch({ effects })
    }

    update(u: ViewUpdate): void {
      if (u.transactions.some(tr => tr.effects.some(e => e.is(refresh)))) this.decorations = this.build(u.view)
      else if (u.docChanged) this.decorations = this.decorations.map(u.changes)
    }

    /** L'etiquette de chaque agent qui ecrit, la ou il ecrit. */
    private build(view: EditorView): DecorationSet {
      const length = view.state.doc.length
      const tags = this.peers
        .filter(p => p.state === 'writing' && p.to !== undefined)
        .map(p => Decoration.widget({ widget: new AgentTagWidget(`${p.name} écrit…`, p.color), side: 1 }).range(Math.min(p.to!, length)))
      return Decoration.set(tags, true)
    }

    destroy(): void {
      this.destroyed = true
      this.unsubscribe()
    }
  }
  return ViewPlugin.fromClass(AgentCursorsView, { decorations: v => v.decorations })
}
