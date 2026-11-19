// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Les systemes de Savoire qu'un plugin implemente : releve de ce qu'il
// enregistre a son chargement, puis analyse (capabilities.ts).
import { describe, it, expect } from 'vitest'
import { analyzeCapabilities, emptyRegistrations, overclaimedCapabilities, pluginTrust, type FileTypeSpec, type PluginAPI } from '@savoire/plugin-api'
import { manifestOfPackage, recordRegistrations, runtimeOf, type StorePackage } from '@savoire/plugin-runtime'

const level = (r: ReturnType<typeof analyzeCapabilities>, id: string) => r.find(c => c.id === id)?.level

const drawing: FileTypeSpec = { extension: 'dessin', label: 'Dessin', icon: 'pen', create: async () => '{}', open: () => ({ mount() {}, destroy() {} }) }

describe('analyzeCapabilities', () => {
  it('un plugin sans document ni texte : aucun systeme', () => {
    const r = analyzeCapabilities({ ...emptyRegistrations(), commands: 2, views: 1 })
    expect(r.every(c => c.level === 'none')).toBe(true)
  })

  it('un type ouvert dans Savoire : revision, comparaison et versions generiques', () => {
    const r = analyzeCapabilities({ ...emptyRegistrations(), fileTypes: [drawing] })
    expect(level(r, 'revision')).toBe('generic')
    expect(level(r, 'compare')).toBe('generic')
    expect(level(r, 'versions')).toBe('generic')
    expect(level(r, 'realtime')).toBe('none')
    expect(level(r, 'search')).toBe('none')
  })

  it('un type CRDT, avec texte extrait, differences et rendu integre : natif', () => {
    const spec: FileTypeSpec = {
      ...drawing, collaborationMode: 'crdt', contentExtractor: { toShadowDocument: s => s },
      review: { diff: () => [] }, renderEmbed: async () => ({}) as HTMLElement,
    }
    const r = analyzeCapabilities({ ...emptyRegistrations(), fileTypes: [spec], proposalTypes: ['dessin.scene'], agents: 1 })
    for (const id of ['search', 'realtime', 'versions', 'revision', 'compare', 'modules', 'ai-local']) expect(level(r, id), id).toBe('native')
    expect(level(r, 'links')).toBe('generic')
    expect(level(r, 'ai-mcp')).toBe('generic')
  })

  it('signale les capacites annoncees mais absentes', () => {
    const r = analyzeCapabilities({ ...emptyRegistrations(), fileTypes: [drawing] })
    expect(overclaimedCapabilities(['revision', 'realtime', 'teleportation'], r)).toEqual(['realtime'])
  })
})

describe('recordRegistrations', () => {
  const registry = () => {
    const calls: unknown[] = []
    return { calls, register(x: unknown) { calls.push(x); return () => {} }, getAll() { return calls } }
  }

  it('releve ce que le plugin enregistre, et le transmet', () => {
    const files = registry(), extractors = registry(), commands = registry()
    const index = { registerFactory(_f: unknown) {} }
    const api = { files, extractors, commands, index } as unknown as PluginAPI
    const { api: seen, registrations } = recordRegistrations(api)
    seen.files.register(drawing)
    seen.extractors!.register({ extensions: ['pdf'], extract: async () => '' } as never)
    seen.commands.register({ id: 'x' } as never)
    seen.index!.registerFactory(() => ({ namespace: 'links' }) as never)
    expect(files.calls).toEqual([drawing])
    expect(extractors.calls).toHaveLength(1)
    expect(registrations.fileTypes).toEqual([drawing])
    expect(registrations.extractors).toEqual(['pdf'])
    expect(registrations.commands).toBe(1)
    expect(registrations.indexes).toEqual(['links'])
    // Les autres methodes du registre marchent toujours (liees au vrai registre).
    expect(seen.files.getAll()).toEqual([drawing])
  })

  it('une partie de l API arrivee apres le chargement est aussi relevee', () => {
    const api = {} as Record<string, unknown>
    const { api: seen, registrations } = recordRegistrations(api as unknown as PluginAPI)
    expect(seen.review).toBeUndefined()
    const types: unknown[] = []
    api.review = { registerProposalType(t: unknown) { types.push(t); return () => {} } }
    seen.review!.registerProposalType({ type: 'dessin.scene' } as never)
    expect(types).toHaveLength(1)
    expect(registrations.proposalTypes).toEqual(['dessin.scene'])
  })
})

describe('paquets du store', () => {
  const pkg = (manifest: Record<string, unknown>): StorePackage => ({
    format: 1, id: 'kanban', kind: 'plugin', version: '1.2.0',
    manifest: { id: 'kanban', name: 'Kanban', version: '1.2.0', ...manifest }, files: { 'main.js': '' },
  })

  it('jamais officiel, pour le vault par defaut, dans la page par defaut', () => {
    const m = manifestOfPackage(pkg({ official: true, permissions: ['vault:read', 42] }))
    expect(m.official).toBe(false)
    // Les plugins du store sont relus par l'equipe Savoire ; un paquet peut se dire non verifie.
    expect(pluginTrust(m)).toBe('verified')
    expect(pluginTrust(manifestOfPackage(pkg({ trust: 'official' })))).toBe('verified')
    expect(pluginTrust(manifestOfPackage(pkg({ trust: 'unverified' })))).toBe('unverified')
    expect(m.scope).toBe('vault')
    expect(m.permissions).toEqual(['vault:read'])
    expect(runtimeOf(pkg({}))).toBe('page')
    expect(runtimeOf(pkg({ runtime: 'frame' }))).toBe('frame')
    expect(manifestOfPackage(pkg({ scope: 'personal', capabilities: ['search', 3] })).capabilities).toEqual(['search'])
  })
})
