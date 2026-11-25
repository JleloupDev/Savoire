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
  /** Ce qu'il fait, dit apres son nom quand il travaille (« lit » par defaut). */
  activity?: string
  /** Sa couleur (« #rrggbb ») ; absente : celle du theme. */
  color?: string
  /** Un bouton a cote du robot (« Suivre »). */
  action?: { label: string; title?: string; active?: boolean; onClick: () => void }
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
      name.textContent = p.busy ? `${p.label} ${p.activity ?? 'lit'}…` : p.label
      chip.append(robot, name)
      chip.addEventListener('mousedown', e => e.preventDefault())
      if (p.onClick) chip.addEventListener('click', () => p.onClick?.())
      if (p.color) {
        chip.style.color = p.color
        chip.style.borderColor = p.color
      }
      if (!p.action) {
        this.dom.appendChild(chip)
        continue
      }
      // Avec un bouton : une rangee, le bouton a gauche du robot.
      const action = p.action
      const row = document.createElement('div')
      row.className = 'cm-agent-presence-row'
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `cm-agent-presence-action${action.active ? ' is-active' : ''}`
      button.setAttribute('data-testid', 'agent-presence-action')
      button.setAttribute('aria-pressed', action.active ? 'true' : 'false')
      button.title = action.title ?? action.label
      button.textContent = action.label
      button.addEventListener('mousedown', e => e.preventDefault())
      button.addEventListener('click', () => action.onClick())
      row.append(button, chip)
      this.dom.appendChild(row)
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
