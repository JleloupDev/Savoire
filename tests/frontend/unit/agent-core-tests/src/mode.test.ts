// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Changer de mode (request_mode, get_mode) : edition ou revision, toujours
// avec l'accord de la personne. Memes cas que backend/src/api/agents.rs.
import { describe, it, expect } from 'vitest'
import { MODE_LABELS, ToolBox, modeLabel, switchMode, writingModeLabel, type ApprovalAnswer, type ApprovalRequest } from '@savoire/agent-core'
import type { AgentDefinition, ToolActor } from '@savoire/plugin-api'
import { MemoryHost } from './memoryHost'

const actor: ToolActor = { agentId: 'a1', agentName: 'Correcteur', onBehalfOf: { userId: 'u1', displayName: 'Jean' } }

function agent(p: Partial<AgentDefinition> = {}): AgentDefinition {
  return { id: 'a1', name: 'Correcteur', description: '', instructions: '', ownerId: 'u1', permissions: { read: 'direct', edit: 'propose', create: 'ask' }, ...p }
}

interface Opts { canWrite?: boolean; approve?: (r: ApprovalRequest) => Promise<ApprovalAnswer>; saved?: AgentDefinition[] }

function box(host: MemoryHost, a: AgentDefinition, o: Opts = {}): ToolBox {
  const saved = o.saved
  return new ToolBox({
    agent: a, person: { canWrite: o.canWrite ?? true }, actor, runtime: 'app', host,
    ...(o.approve ? { approve: o.approve } : {}),
    ...(saved ? { saveAgent: async (x: AgentDefinition) => { saved.push(x) } } : {}),
  })
}

describe('changer de mode', () => {
  it('edition : modifier et creer en direct ; revision : modifier propose, creer demande ; une action interdite le reste', () => {
    const e = switchMode({ read: 'direct', edit: 'propose', create: 'ask', delete: 'ask' }, 'direct')
    expect(e).toMatchObject({ edit: 'direct', create: 'direct', delete: 'ask' })
    expect(switchMode(e, 'propose')).toMatchObject({ edit: 'propose', create: 'ask' })
    expect(switchMode({ edit: 'ask' }, 'direct')).toMatchObject({ edit: 'direct', create: 'deny' })
  })

  it('« demander » se lit « demander l autorisation avant d ecrire », sauf pour deleguer', () => {
    expect(MODE_LABELS.ask).toBe('Demander l’autorisation avant d’écrire')
    expect(modeLabel('edit', 'ask')).toBe('Demander l’autorisation avant d’écrire')
    expect(modeLabel('delegate', 'ask')).toBe('Demander avant')
    expect(writingModeLabel(agent())).toContain('révision')
    expect(writingModeLabel(agent({ permissions: { edit: 'direct' } }), { canWrite: false })).toBe('ne modifie pas les notes')
  })

  it('les outils n existent que si l appli sait enregistrer l agent, et request_mode seulement si l agent le permet', () => {
    const names = (b: ToolBox) => b.specs().map(s => s.name)
    expect(names(box(new MemoryHost(), agent()))).not.toContain('request_mode')
    expect(names(box(new MemoryHost(), agent(), { saved: [] }))).toEqual(expect.arrayContaining(['get_mode', 'request_mode']))
    const off = names(box(new MemoryHost(), agent({ canRequestMode: false }), { saved: [] }))
    expect(off).toContain('get_mode')
    expect(off).not.toContain('request_mode')
  })

  it('refusee : rien ne change, l agent propose toujours', async () => {
    const host = new MemoryHost({ 'a.md': 'Bonjour le monde' })
    const saved: AgentDefinition[] = []
    let asked = ''
    const b = box(host, agent(), { saved, approve: async r => { asked = r.summary; return 'refused' } })
    const r = await b.call('request_mode', { mode: 'direct', reason: 'Corriger vite.' })
    expect(r.approval).toBe('refused')
    expect(asked).toBe('Passer en mode édition (modifications directes) : Corriger vite.')
    expect(saved).toEqual([])
    await b.call('edit_note', { path: 'a.md', find: 'le monde', replace: 'tout le monde' })
    expect(host.content('a.md')).toBe('Bonjour le monde')
  })

  it('acceptee : l agent est enregistre en edition et modifie directement', async () => {
    const host = new MemoryHost({ 'a.md': 'Bonjour le monde' })
    const saved: AgentDefinition[] = []
    const b = box(host, agent(), { saved, approve: async () => 'approved' })
    const r = await b.call('request_mode', { mode: 'direct', reason: 'Corriger.' })
    expect(r.result.isError).toBeFalsy()
    expect(saved.map(a => a.permissions)).toMatchObject([{ edit: 'direct', create: 'direct' }])
    expect((await b.call('get_mode', {})).result.text).toContain('édition')
    await b.call('edit_note', { path: 'a.md', find: 'le monde', replace: 'tout le monde' })
    expect(host.content('a.md')).toBe('Bonjour tout le monde')
  })

  it('en attente, deja dans ce mode, ou sans rien a changer : pas d enregistrement', async () => {
    const saved: AgentDefinition[] = []
    const pending = await box(new MemoryHost(), agent(), { saved, approve: async () => ({ pending: 'ap-1' }) }).call('request_mode', { mode: 'direct', reason: 'x' })
    expect(pending.result.pending).toEqual({ approvalId: 'ap-1' })
    const same = await box(new MemoryHost(), agent(), { saved, approve: async () => 'approved' }).call('request_mode', { mode: 'propose', reason: 'x' })
    expect(same.result.text).toContain('déjà en mode révision')
    const none = await box(new MemoryHost(), agent({ permissions: { read: 'direct' } }), { saved, approve: async () => 'approved' }).call('request_mode', { mode: 'direct', reason: 'x' })
    expect(none.result.isError).toBe(true)
    expect(saved).toEqual([])
  })

  it('une lectrice : meme accepte, l agent n ecrit pas', async () => {
    const host = new MemoryHost({ 'a.md': 'Bonjour le monde' })
    const b = box(host, agent(), { canWrite: false, saved: [], approve: async () => 'approved' })
    await b.call('request_mode', { mode: 'direct', reason: 'x' })
    expect(b.modeOf('edit')).toBe('deny')
    expect((await b.call('edit_note', { path: 'a.md', find: 'le monde', replace: 'x' })).result.isError).toBe(true)
    expect(host.content('a.md')).toBe('Bonjour le monde')
  })
})
