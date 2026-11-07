// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Plugins core (comme ceux d'Obsidian) : toujours installes, ils s'activent
// ou se desactivent, ils ne se desinstallent pas.
import { describe, it, expect, afterEach } from 'vitest'
import { PluginSettingsService, type IVaultSyncSession, type PersonalPluginState, type PluginCatalogEntry } from '@savoire/application'
import { InProcessPeerBus, LocalPeerVaultSessionFactory } from '@savoire/infrastructure-sync'

const SETTLE_MS = 5

const CATALOG: PluginCatalogEntry[] = [
  { manifest: { id: 'plugin-backlinks', name: 'Rétroliens', version: '1', scope: 'vault' }, preinstalled: true, core: true },
  { manifest: { id: 'plugin-agenda', name: 'Agenda', version: '1', scope: 'personal' }, preinstalled: true, core: true },
  { manifest: { id: 'plugin-quickref', name: 'QuickRef', version: '1', scope: 'vault' }, preinstalled: false },
]

function service(initial: PersonalPluginState = { installed: [], removed: [], disabled: [] }) {
  let saved = initial
  let disabled: string[] = []
  const svc = new PluginSettingsService(() => CATALOG, { setDisabled: ids => { disabled = [...ids].sort() } }, {
    load: () => saved,
    save: s => { saved = s },
  })
  return { svc, disabled: () => disabled }
}

describe('plugins core', () => {
  const factory = new LocalPeerVaultSessionFactory(new InProcessPeerBus(), { settleMs: SETTLE_MS })
  const sessions: IVaultSyncSession[] = []
  afterEach(async () => { for (const s of sessions.splice(0)) await s.dispose() })

  it('installes et actifs par defaut, marques core', () => {
    const { svc } = service()
    const core = svc.list().filter(p => p.core)
    expect(core.map(p => p.id)).toEqual(['plugin-backlinks', 'plugin-agenda'])
    expect(core.every(p => p.installed && p.enabled)).toBe(true)
    expect(svc.list().find(p => p.id === 'plugin-quickref')!.core).toBe(false)
  })

  it('se desactivent et se reactivent, sans jamais se desinstaller', async () => {
    const session = await factory.open({ vaultId: 'core', token: '', userId: 'alice', onChanged: () => {} })
    sessions.push(session)
    const { svc, disabled } = service()
    svc.attachVault(session)
    svc.setEnabled('plugin-backlinks', false)
    expect(disabled()).toContain('plugin-backlinks')
    expect(svc.list().find(p => p.id === 'plugin-backlinks')!.installed).toBe(true)
    expect(() => svc.uninstall('plugin-backlinks')).toThrow('plugin core')
    svc.install('plugin-backlinks')
    expect(disabled()).not.toContain('plugin-backlinks')
  })

  it('un plugin personnel desinstalle avant de devenir core reste coupe, puis se reactive', () => {
    const { svc, disabled } = service({ installed: [], removed: ['plugin-agenda'], disabled: [] })
    expect(disabled()).toContain('plugin-agenda')
    svc.setEnabled('plugin-agenda', true)
    expect(disabled()).not.toContain('plugin-agenda')
  })
})
