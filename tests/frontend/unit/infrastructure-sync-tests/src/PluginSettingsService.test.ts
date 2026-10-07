// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Activation des plugins selon leur portee : vault (partage, par la session)
// ou personnel (chez la personne). Teste avec de vrais pairs du connecteur
// local : un plugin de vault desactive par Alice l'est aussi chez Bob.
import { describe, it, expect, afterEach } from 'vitest'
import { PluginSettingsService, type IPersonalPluginStore, type IVaultSyncSession } from '@savoire/application'
import type { PluginManifest } from '@savoire/plugin-api'
import { InProcessPeerBus, LocalPeerVaultSessionFactory } from '@savoire/infrastructure-sync'

const SETTLE_MS = 5
const settle = () => new Promise(r => setTimeout(r, SETTLE_MS * 4))

const MANIFESTS: PluginManifest[] = [
  { id: 'plugin-filetree', name: 'Explorateur', version: '1', scope: 'vault', essential: true },
  { id: 'plugin-table', name: 'Tables', version: '1', scope: 'vault' },
  { id: 'plugin-graph', name: 'Graphe', version: '1' },
  { id: 'plugin-search', name: 'Recherche', version: '1', scope: 'personal' },
]

function memoryStore(initial: string[] = []): IPersonalPluginStore & { saved: string[] } {
  const store = {
    saved: [...initial],
    loadDisabled: () => [...store.saved],
    saveDisabled: (ids: string[]) => { store.saved = [...ids] },
  }
  return store
}

function service(personal = memoryStore()) {
  let disabled: string[] = []
  const svc = new PluginSettingsService(() => MANIFESTS, { setDisabled: ids => { disabled = [...ids].sort() } }, personal)
  return { svc, disabled: () => disabled, personal }
}

describe('PluginSettingsService', () => {
  const factory = new LocalPeerVaultSessionFactory(new InProcessPeerBus(), { settleMs: SETTLE_MS })
  const sessions: IVaultSyncSession[] = []
  const vault = async (userId: string) => {
    const s = await factory.open({ vaultId: 'v1', token: '', userId, onChanged: () => {} })
    sessions.push(s)
    return s
  }

  afterEach(async () => {
    for (const s of sessions.splice(0)) await s.dispose()
  })

  it('tout est actif par defaut, et un plugin sans portee est un plugin de vault', () => {
    const { svc, disabled } = service()
    expect(svc.list().every(p => p.enabled)).toBe(true)
    expect(svc.list().find(p => p.id === 'plugin-graph')!.scope).toBe('vault')
    expect(disabled()).toEqual([])
  })

  it('un plugin indispensable ne se desactive pas', () => {
    const { svc } = service()
    expect(svc.canChange('plugin-filetree')).toBe(false)
    expect(() => svc.setEnabled('plugin-filetree', false)).toThrow('indispensable')
  })

  it('un plugin personnel se regle sans vault et se memorise chez la personne', () => {
    const { svc, disabled, personal } = service()
    svc.setEnabled('plugin-search', false)
    expect(disabled()).toEqual(['plugin-search'])
    expect(personal.saved).toEqual(['plugin-search'])

    const again = service(memoryStore(personal.saved))
    expect(again.disabled()).toEqual(['plugin-search'])
  })

  it('un plugin de vault exige un vault ouvert', () => {
    const { svc } = service()
    expect(svc.canChange('plugin-table')).toBe(false)
    expect(() => svc.setEnabled('plugin-table', false)).toThrow('vault')
  })

  it('un plugin de vault desactive par un membre l\'est chez tous', async () => {
    const alice = service()
    const bob = service()
    alice.svc.attachVault(await vault('alice'))
    bob.svc.attachVault(await vault('bob'))
    await settle()

    alice.svc.setEnabled('plugin-table', false)
    expect(alice.disabled()).toEqual(['plugin-table'])
    await settle()
    expect(bob.disabled()).toEqual(['plugin-table'])
    expect(bob.svc.list().find(p => p.id === 'plugin-table')!.enabled).toBe(false)

    bob.svc.setEnabled('plugin-table', true)
    await settle()
    expect(alice.disabled()).toEqual([])
  })

  it('un choix personnel ne sort pas de chez la personne', async () => {
    const alice = service()
    const bob = service()
    alice.svc.attachVault(await vault('alice'))
    bob.svc.attachVault(await vault('bob'))
    alice.svc.setEnabled('plugin-search', false)
    await settle()
    expect(bob.disabled()).toEqual([])
  })

  it('changer de vault remplace les reglages de vault', async () => {
    const { svc, disabled } = service()
    svc.attachVault(await vault('alice'))
    svc.setEnabled('plugin-table', false)
    expect(disabled()).toEqual(['plugin-table'])
    svc.attachVault(undefined)
    expect(disabled()).toEqual([])
  })
})
