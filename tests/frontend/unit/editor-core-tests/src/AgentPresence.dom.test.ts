// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Presence d'un agent sur la note : le robot en bas a droite, anime quand il lit.
import { describe, it, expect, afterEach } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { agentPresenceExtension, applyAgentPresence } from '../../../../../packages/editor-core/src/AgentPresence'

const views: EditorView[] = []
afterEach(() => { for (const v of views.splice(0)) v.destroy() })

describe('presence d un agent', () => {
  it('robot visible, anime quand il lit, clic, puis retire', () => {
    const view = new EditorView({ parent: document.body, state: EditorState.create({ doc: 'Texte', extensions: [agentPresenceExtension()] }) })
    views.push(view)
    const box = view.dom.querySelector('[data-testid="agent-presence"]') as HTMLElement
    expect(box.hidden).toBe(true)
    let clicked = 0
    applyAgentPresence(view, 'watch:r1', { label: 'Relecteur', busy: true, onClick: () => { clicked++ } })
    const chip = box.querySelector('.cm-agent-presence-chip') as HTMLButtonElement
    expect(box.hidden).toBe(false)
    expect(chip.classList.contains('is-busy')).toBe(true)
    expect(chip.textContent).toContain('Relecteur lit…')
    chip.click()
    expect(clicked).toBe(1)
    applyAgentPresence(view, 'watch:r1', { label: 'Relecteur', busy: false })
    expect(box.querySelector('.cm-agent-presence-chip')!.classList.contains('is-busy')).toBe(false)
    applyAgentPresence(view, 'watch:r1', null)
    expect(box.hidden).toBe(true)
  })
})
