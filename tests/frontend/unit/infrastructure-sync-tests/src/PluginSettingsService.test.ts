// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Activation des plugins selon leur portee : vault (partage, par la session)
// ou personnel (chez la personne). Teste avec de vrais pairs du connecteur
// local : un plugin de vault desactive par Alice l'est aussi chez Bob.
import { describe, it, expect, afterEach } from 'vitest'
import { PluginSettingsService, type IPersonalPluginStore, type IVaultSyncSession, type PersonalPluginState, type PluginCatalogEntry } from '@savoire/application'
import type { PluginManifest } from '@savoire/plugin-api'
import { InProcessPeerBus, LocalPeerVaultSessionFactory } from '@savoire/infrastructure-sync'

const SETTLE_MS = 5
const settle = () => new Promise(r => setTimeout(r, SETTLE_MS * 4))

const preinstalled = (manifest: PluginManifest): PluginCatalogEntry => ({ manifest, preinstalled: true })
const inStore = (manifest: PluginManifest): PluginCatalogEntry => ({ manifest, preinstalled: false })

const CATALOG: PluginCatalogEntry[] = [
  preinstalled({ id: 'plugin-filetree', name: 'Explorateur', version: '1', scope: 'vault', essential: true }),
  preinstalled({ id: 'plugin-table', name: 'Tables', version: '1', scope: 'vault' }),
  preinstalled({ id: 'plugin-graph', name: 'Graphe', version: '1' }),
  preinstalled({ id: 'plugin-search', name: 'Recherche', version: '1', scope: 'personal' }),
  inStore({ id: 'plugin-wtf', name: 'WTF', version: '1', scope: 'vault' }),
  inStore({ id: 'plugin-theme', name: 'Theme', version: '1', scope: 'personal' }),
]
const STORE_ONLY = ['plugin-theme', 'plugin-wtf']

function memoryStore(initial: PersonalPluginState = { installed: [], removed: [], disabled: [] }): IPersonalPluginStore & { saved: PersonalPluginState } {
  const store = {
    saved: initial,
    load: () => ({ installed: [...store.saved.installed], removed: [...store.saved.removed], disabled: [...store.saved.disabled] }),
    save: (state: PersonalPluginState) => { store.saved = state },
  }
  return store
}

function service(personal = memoryStore()) {
  let disabled: string[] = []
  const svc = new PluginSettingsService(() => CATALOG, { setDisabled: ids => { disabled = [...ids].sort() } }, personal)
  // Les plugins du store non installes sont toujours filtres : on ne regarde que le reste.
  return { svc, disabled: () => disabled.filter(id => !STORE_ONLY.includes(id) || svc.installedIds().includes(id)), personal }
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

  it('le coeur est installe et actif par defaut, et un plugin sans portee est un plugin de vault', () => {
    const { svc, disabled } = service()
    expect(svc.list().filter(p => p.preinstalled).every(p => p.installed && p.enabled)).toBe(true)
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
    expect(personal.saved.disabled).toEqual(['plugin-search'])

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

  it('un plugin du store n\'est ni installe ni actif tant qu\'on ne l\'installe pas', () => {
    let disabled: string[] = []
    const svc = new PluginSettingsService(() => CATALOG, { setDisabled: ids => { disabled = [...ids] } }, memoryStore())
    const wtf = svc.list().find(p => p.id === 'plugin-wtf')!
    expect(wtf).toMatchObject({ installed: false, enabled: false, preinstalled: false })
    expect(disabled).toContain('plugin-wtf')
    expect(svc.installedIds()).not.toContain('plugin-wtf')
    expect(() => svc.setEnabled('plugin-wtf', true)).toThrow('pas installe')
  })

  it('un plugin de vault installe par un membre l\'est chez tous ; desinstalle, il disparait', async () => {
    const alice = service()
    const bob = service()
    alice.svc.attachVault(await vault('alice'))
    bob.svc.attachVault(await vault('bob'))
    await settle()

    alice.svc.install('plugin-wtf')
    await settle()
    expect(bob.svc.installedIds()).toContain('plugin-wtf')
    expect(bob.svc.list().find(p => p.id === 'plugin-wtf')!.enabled).toBe(true)

    bob.svc.uninstall('plugin-wtf')
    await settle()
    expect(alice.svc.installedIds()).not.toContain('plugin-wtf')
  })

  it('un plugin personnel du store s\'installe chez la personne seulement', () => {
    const { svc, personal } = service()
    svc.install('plugin-theme')
    expect(svc.installedIds()).toContain('plugin-theme')
    expect(personal.saved.installed).toEqual(['plugin-theme'])
    expect(service(memoryStore()).svc.installedIds()).not.toContain('plugin-theme')
  })

  it('un plugin preinstalle de vault se desinstalle, revient dans le store, et se reinstalle', async () => {
    const alice = service()
    const bob = service()
    alice.svc.attachVault(await vault('alice'))
    bob.svc.attachVault(await vault('bob'))
    await settle()

    alice.svc.uninstall('plugin-table')
    await settle()
    const table = (svc: PluginSettingsService) => svc.list().find(p => p.id === 'plugin-table')!
    expect(table(bob.svc)).toMatchObject({ preinstalled: true, installed: false, enabled: false })
    expect(bob.disabled()).toContain('plugin-table')

    bob.svc.install('plugin-table')
    await settle()
    expect(table(alice.svc)).toMatchObject({ installed: true, enabled: true })
  })

  it('un plugin preinstalle personnel se desinstalle chez la personne seulement', () => {
    const { svc, personal } = service()
    svc.uninstall('plugin-search')
    expect(svc.installedIds()).not.toContain('plugin-search')
    expect(personal.saved.removed).toEqual(['plugin-search'])
    svc.install('plugin-search')
    expect(svc.installedIds()).toContain('plugin-search')
    expect(personal.saved.removed).toEqual([])
  })

  it('un plugin indispensable ne se desinstalle pas', () => {
    const { svc } = service()
    expect(() => svc.uninstall('plugin-filetree')).toThrow('indispensable')
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
