// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Presence d'un agent sur la note : un petit robot en bas a droite de
// l'editeur, qui « travaille » (anime) quand l'agent lit un passage, et reste
// calme quand il attend la prochaine pause de frappe. Pose par
// l'application (agents en veille), une presence par source.

import { StateEffect, StateField, type Extension } from '@codemirror/state'
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'

export interface AgentPresence {
  /** Nom affiche (« Relecteur »). */
  label: string
  /** Infobulle (ce qu'il fait). */
  title?: string
  /** En train de lire : le robot s'anime. */
  busy: boolean
  /** Clic sur le robot (ouvrir le panneau Agents...). */
  onClick?: () => void
}

const setPresence = StateEffect.define<{ owner: string; presence: AgentPresence | null }>()

const field = StateField.define<ReadonlyMap<string, AgentPresence>>({
  create: () => new Map(),
  update(value, tr) {
    let next: Map<string, AgentPresence> | null = null
    for (const e of tr.effects) {
      if (!e.is(setPresence)) continue
      next ??= new Map(value)
      if (e.value.presence) next.set(e.value.owner, e.value.presence)
      else next.delete(e.value.owner)
    }
    return next ?? value
  },
})

class PresenceView {
  private readonly dom: HTMLElement
  private shown: ReadonlyMap<string, AgentPresence> | null = null

  constructor(private readonly view: EditorView) {
    this.dom = document.createElement('div')
    this.dom.className = 'cm-agent-presence'
    this.dom.setAttribute('data-testid', 'agent-presence')
    view.dom.appendChild(this.dom)
    this.render()
  }

  update(u: ViewUpdate): void {
    if (u.state.field(field) !== this.shown) this.render()
  }

  private render(): void {
    const all = this.view.state.field(field)
    this.shown = all
    this.dom.replaceChildren()
    this.dom.hidden = all.size === 0
    for (const p of all.values()) {
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = `cm-agent-presence-chip${p.busy ? ' is-busy' : ''}`
      chip.title = p.title ?? p.label
      chip.setAttribute('aria-label', chip.title)
      const robot = document.createElement('span')
      robot.className = 'cm-agent-presence-robot'
      robot.textContent = '🤖'
      const name = document.createElement('span')
      name.className = 'cm-agent-presence-label'
      name.textContent = p.busy ? `${p.label} lit…` : p.label
      chip.append(robot, name)
      chip.addEventListener('mousedown', e => e.preventDefault())
      if (p.onClick) chip.addEventListener('click', () => p.onClick?.())
      this.dom.appendChild(chip)
    }
  }

  destroy(): void {
    this.dom.remove()
  }
}

export function agentPresenceExtension(): Extension {
  return [field, ViewPlugin.fromClass(PresenceView)]
}

/** Pose (ou retire, avec null) la presence d'une source. */
export function applyAgentPresence(view: EditorView, owner: string, presence: AgentPresence | null): void {
  view.dispatch({ effects: setPresence.of({ owner, presence }) })
}
