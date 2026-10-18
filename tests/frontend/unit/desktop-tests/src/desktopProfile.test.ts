// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Profil bureau : detection de Tauri, choix du profil, vaults recents,
// fabrique de sessions sur disque. Le pont Tauri est simule.
import { describe, it, expect, vi } from 'vitest'
import type { IVaultSyncSession, VaultSyncSessionFactoryParams } from '@savoire/application'
import {
  createDesktopHost, displayPath, pathForVaultId, sortRecent, vaultIdForPath, TauriVaultFileSystem,
  type RecentVault,
} from '@savoire/desktop'
import { isTauriRuntime } from '../../../../../apps/web/src/tauriRuntime'
import { readProfileFromUrl } from '../../../../../apps/web/src/profile'
import {
  DesktopVaultSessionFactory, DesktopVaultsBackend, FolderPickCancelled, OpenedFolders, toVaultSummary,
} from '../../../../../apps/web/src/createDesktopRoot'
import { FakeBridge } from './fakeBridge'

const tauriGlobals = () => ({ isTauri: true, __TAURI_INTERNALS__: { invoke: () => {} } })

describe('detection de Tauri 2', () => {
  it('exige le drapeau et le pont IPC', () => {
    expect(isTauriRuntime(tauriGlobals())).toBe(true)
    expect(isTauriRuntime({})).toBe(false)
    expect(isTauriRuntime({ isTauri: true })).toBe(false)
    expect(isTauriRuntime({ __TAURI_INTERNALS__: { invoke: () => {} } })).toBe(false)
    // Marques de Tauri 1 : ce n'est pas la coquille bureau actuelle.
    expect(isTauriRuntime({ __TAURI__: {}, __TAURI_IPC__: () => {} })).toBe(false)
    expect(isTauriRuntime(undefined)).toBe(false)
    // Le navigateur de test (node) n'est pas Tauri.
    expect(isTauriRuntime()).toBe(false)
  })
})

describe('choix du profil', () => {
  it('dans Tauri, le profil bureau d\'office', () => {
    expect(readProfileFromUrl('', true)).toBe('desktop')
    expect(readProfileFromUrl('?profile=local', true)).toBe('local')
  })

  it('hors de Tauri, jamais le profil bureau', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(readProfileFromUrl('', false)).toBe('server')
    expect(readProfileFromUrl('?profile=desktop', false)).toBe('server')
    expect(readProfileFromUrl('?profile=local', false)).toBe('local')
    warn.mockRestore()
  })
})

describe('vaults recents', () => {
  const recent = (path: string, lastOpenedMs: number, exists?: boolean): RecentVault =>
    ({ path, name: path.split('/').pop()!, lastOpenedMs, exists })

  it('les plus recents d\'abord, les introuvables a la fin', () => {
    const sorted = sortRecent([recent('/a', 1), recent('/b', 3, false), recent('/c', 2, true)])
    expect(sorted.map(v => v.path)).toEqual(['/c', '/a', '/b'])
  })

  it('identifiant de vault <-> dossier', () => {
    const id = vaultIdForPath('/home/moi/Notes')
    expect(pathForVaultId(id)).toBe('/home/moi/Notes')
    expect(pathForVaultId('5f0c-uuid-serveur')).toBeNull()
    expect(toVaultSummary(recent('/home/moi/Notes', 0))).toMatchObject({ id, name: 'Notes', role: 'local', lastModifiedAt: null })
    expect(toVaultSummary(recent('/x', 5, false)).role).toBe('introuvable')
  })

  it('chemin affiche', () => {
    expect(displayPath('/home/moi/Notes', '/home/moi')).toBe('~/Notes')
    expect(displayPath('/home/moi', '/home/moi/')).toBe('~')
    expect(displayPath('/home/moitie/x', '/home/moi')).toBe('/home/moitie/x')
    expect(displayPath('C:\\Users\\moi\\Notes', 'C:\\Users\\moi')).toBe('~/Notes')
  })
})

describe('hote bureau', () => {
  const vault: RecentVault = { path: '/home/moi/Notes', name: 'Notes', lastOpenedMs: 10 }

  it('annuler la boite de dialogue rend null, choisir rend le systeme de fichiers du dossier', async () => {
    let answer: RecentVault | null = null
    const bridge = new FakeBridge().on('vault_pick_folder', () => answer)
    const host = createDesktopHost(bridge)
    expect(await host.pickVaultFolder()).toBeNull()
    answer = vault
    const opened = await host.pickVaultFolder()
    expect(opened?.vault).toEqual(vault)
    expect(opened?.fs).toBeInstanceOf(TauriVaultFileSystem)
    expect((opened?.fs as TauriVaultFileSystem).root).toBe(vault.path)
  })

  it('cree, liste, rouvre, renomme et oublie par les commandes Rust', async () => {
    const bridge = new FakeBridge()
      .on('vault_create_folder', () => vault)
      .on('vault_recent_list', () => [{ ...vault, lastOpenedMs: 1 }, { path: '/b', name: 'b', lastOpenedMs: 2 }])
      .on('vault_recent_open', () => vault)
    const host = createDesktopHost(bridge)
    await host.createVaultFolder('Notes')
    expect((await host.listRecent()).map(v => v.path)).toEqual(['/b', vault.path])
    await host.openRecent(vault.path)
    await host.renameRecent(vault.path, 'Mes notes')
    await host.forgetRecent(vault.path)
    expect(bridge.calls.map(c => [c.cmd, c.args])).toEqual([
      ['vault_create_folder', { name: 'Notes' }],
      ['vault_recent_list', undefined],
      ['vault_recent_open', { path: vault.path }],
      ['vault_recent_rename', { path: vault.path, name: 'Mes notes' }],
      ['vault_recent_forget', { path: vault.path }],
    ])
  })
})

describe('profil bureau : liste des vaults et sessions', () => {
  const vault: RecentVault = { path: '/home/moi/Notes', name: 'Notes', lastOpenedMs: 10 }
  const id = vaultIdForPath(vault.path)

  function setup(answers: { create?: RecentVault | null } = {}) {
    const bridge = new FakeBridge()
      .on('vault_recent_list', () => [{ ...vault, exists: true }])
      .on('vault_recent_open', () => vault)
      .on('vault_create_folder', () => answers.create ?? null)
    const host = createDesktopHost(bridge)
    const opened = new OpenedFolders(host)
    return { bridge, host, opened, backend: new DesktopVaultsBackend(host, opened) }
  }

  it('la liste = les dossiers recents', async () => {
    const { backend } = setup()
    const { vaults, sharedWithMe } = await backend.listVaults()
    expect(vaults.map(v => [v.id, v.name, v.role])).toEqual([[id, 'Notes', 'local']])
    expect(sharedWithMe).toEqual([])
  })

  it('« supprimer » retire de la liste et ne touche jamais au dossier', async () => {
    const { backend, bridge } = setup()
    await backend.deleteVault(id)
    expect(bridge.commands()).toEqual(['vault_recent_forget'])
    expect(bridge.commands().some(c => c === 'vault_remove')).toBe(false)
  })

  it('creer : annule -> FolderPickCancelled, choisi -> vault retenu', async () => {
    await expect(setup().backend.createVault('local', 'Notes')).rejects.toBeInstanceOf(FolderPickCancelled)
    const { backend, opened, bridge } = setup({ create: vault })
    const summary = await backend.createVault('local', 'Notes')
    expect(summary.id).toBe(id)
    // Deja connu : pas besoin de redemander le dossier a Rust.
    await opened.fileSystemOf(id)
    expect(bridge.commands()).toEqual(['vault_create_folder'])
  })

  it('la session s\'ouvre sur le systeme de fichiers du dossier, rouvert si besoin', async () => {
    const { opened, bridge } = setup()
    const session = {} as IVaultSyncSession
    const openOnDisk = vi.fn(async () => session)
    const factory = new DesktopVaultSessionFactory(opened, openOnDisk)
    const params = { vaultId: id, token: 'local', userId: 'local', onChanged: () => {} } satisfies VaultSyncSessionFactoryParams

    expect(await factory.open(params)).toBe(session)
    expect(bridge.commands()).toEqual(['vault_recent_open'])
    const [fs, passed] = openOnDisk.mock.calls[0] as unknown as [TauriVaultFileSystem, VaultSyncSessionFactoryParams]
    expect(fs.root).toBe(vault.path)
    expect(passed).toBe(params)

    await expect(factory.open({ ...params, vaultId: 'uuid-serveur' })).rejects.toThrow(/pas un dossier/)
  })
})
