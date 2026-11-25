// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Presence d'un agent dans une note (ADR-033) : sa couleur, et ce que les
// outils disent a l'hote quand ils lisent ou ecrivent.
import { describe, it, expect } from 'vitest'
import { AGENT_COLORS, ToolBox, agentColor, isAgentColor, type AgentToolHost } from '@savoire/agent-core'
import type { AgentDefinition, ToolActor } from '@savoire/plugin-api'
import { MemoryHost } from './memoryHost'

type Signal = Parameters<NonNullable<AgentToolHost['signal']>>[0]

class SignalingHost extends MemoryHost {
  signals: Signal[] = []
  signal(s: Signal): void { this.signals.push(s) }
}

const actor: ToolActor = { agentId: 'a1', agentName: 'Archiviste', onBehalfOf: { userId: 'u1', displayName: 'Jean' } }
const agent: AgentDefinition = { id: 'a1', name: 'Archiviste', description: '', instructions: '', ownerId: 'u1', permissions: { read: 'direct', edit: 'direct' } }

function box(host: AgentToolHost, imposedMode?: 'propose'): ToolBox {
  return new ToolBox({ agent, person: { canWrite: true }, actor, runtime: 'app', host, ...(imposedMode ? { imposedMode } : {}) })
}

describe('couleur d un agent', () => {
  it('la sienne si elle est valide, en minuscules', () => {
    expect(agentColor({ id: 'a1', color: '#0A7FC2' })).toBe('#0a7fc2')
  })

  it('sinon derivee de son id : stable, prise dans la palette', () => {
    const c = agentColor({ id: 'a1' })
    expect(AGENT_COLORS).toContain(c)
    expect(agentColor({ id: 'a1' })).toBe(c)
    expect(agentColor({ id: 'a1', color: 'rouge' })).toBe(c)
    // Des agents differents ne tombent pas tous sur la meme couleur.
    const seen = new Set(Array.from({ length: 40 }, (_, i) => agentColor({ id: `agent-${i}` })))
    expect(seen.size).toBeGreaterThan(5)
  })

  it('reconnait #rrggbb seulement', () => {
    expect(isAgentColor('#12abEF')).toBe(true)
    for (const bad of ['#fff', 'rouge', '#12345g', '#1234567', '', null, 3]) expect(isAgentColor(bad)).toBe(false)
  })
})

describe('les outils disent ce que l agent fait', () => {
  it('lire une note : le passage lu', async () => {
    const host = new SignalingHost({ 'A.md': 'Bonjour le monde' })
    await box(host).call('read_note', { path: 'A.md' })
    expect(host.signals).toEqual([{ docId: host.idOf('A.md'), state: 'reading', from: 0, to: 16 }])
  })

  it('modifier un passage : le texte qu il vient d ecrire, une fois l ecriture faite', async () => {
    const host = new SignalingHost({ 'A.md': 'Bonjour le monde' })
    const r = await box(host).call('edit_note', { path: 'A.md', find: 'le monde', replace: 'tout le monde' })
    expect(r.result.isError).toBeFalsy()
    expect(host.content('A.md')).toBe('Bonjour tout le monde')
    expect(host.signals).toEqual([{ docId: host.idOf('A.md'), state: 'writing', from: 8, to: 21 }])
  })

  it('proposer ne montre pas d ecriture : rien n a change', async () => {
    const host = new SignalingHost({ 'A.md': 'Il ont manger' })
    await box(host, 'propose').call('edit_note', { path: 'A.md', find: 'Il ont manger', replace: 'Ils ont mangé' })
    expect(host.signals).toEqual([])
  })

  it('un hote sans presence marche comme avant', async () => {
    const host = new MemoryHost({ 'A.md': 'Bonjour' })
    const r = await box(host).call('append', { path: 'A.md', text: 'Suite' })
    expect(r.result.isError).toBeFalsy()
    expect(host.content('A.md')).toBe('Bonjour\n\nSuite')
  })
})
