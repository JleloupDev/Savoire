// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Service de telechargement / envoi d'un vault : ouverture et fermeture des
// sessions, dossier cible, creation du vault, progression, annulation.
// Les deux cotes sont des sessions du profil local ; le « disque » est un
// InMemoryVaultFileSystem dont la session garde son contenu tant que le test
// tourne (un pair garde la replique).
import { describe, it, expect, afterEach, vi } from 'vitest'
import { InProcessPeerBus, LocalPeerVaultSessionFactory } from '@savoire/infrastructure-sync'
import { InMemoryVaultFileSystem, type IVaultFileSystem } from '@savoire/platform'
import {
  VaultTransferService, type IVaultSyncSession, type VaultSyncSessionFactoryParams, type VaultTransferProgress,
} from '@savoire/application'

const SETTLE_MS = 5
const keepers: IVaultSyncSession[] = []
afterEach(async () => { for (const s of keepers.splice(0)) await s.dispose() })

/** « Serveur » : un bus, un pair qui garde tout. */
function fakeServer() {
  const factory = new LocalPeerVaultSessionFactory(new InProcessPeerBus(), { settleMs: SETTLE_MS })
  const created: string[] = []
  const opened: string[] = []
  return {
    created, opened,
    async keeper(vaultId: string) {
      const s = await factory.open({ vaultId, token: '', userId: 'serveur', onChanged: () => {} })
      keepers.push(s)
      return s
    },
    sessions: { open: async (p: VaultSyncSessionFactoryParams) => { opened.push(p.vaultId); return factory.open(p) } },
    vaults: {
      create: vi.fn(async (_userId: string, name: string) => {
        const id = `v-${name}`
        created.push(id)
        return { id, name, role: 'owner', documentCount: 0, folderCount: 0, lastModifiedAt: null, sizeBytes: 0 }
      }),
    },
  }
}

/** « Disque » : un bus par dossier ; un pair garde le contenu ecrit. */
function fakeDisk() {
  const buses = new Map<IVaultFileSystem, InProcessPeerBus>()
  const open = async (fs: IVaultFileSystem, params: VaultSyncSessionFactoryParams): Promise<IVaultSyncSession> => {
    let bus = buses.get(fs)
    const factory = () => new LocalPeerVaultSessionFactory(bus!, { settleMs: SETTLE_MS })
    if (!bus) {
      bus = new InProcessPeerBus()
      buses.set(fs, bus)
      keepers.push(await factory().open({ ...params, vaultId: 'disque', userId: 'disque' }))
      await fs.writeText('.savoire/vault.json', '{}')
    }
    // Le vault d'un dossier est le dossier lui-meme, quel que soit l'id demande.
    return factory().open({ ...params, vaultId: 'disque' })
  }
  return { open: vi.fn(open) }
}

const auth = { userId: 'alice', token: 't' }
const settle = () => new Promise(r => setTimeout(r, SETTLE_MS * 4))

describe('VaultTransferService', () => {
  it('telecharge un vault dans un dossier vide, puis ferme ses sessions', async () => {
    const server = fakeServer()
    const remote = await server.keeper('v1')
    remote.directory.add({ id: 'n1', path: 'Note.md' })
    remote.directory.addFolder('Vide/')
    await settle()
    const disk = fakeDisk()
    const service = new VaultTransferService({ remote: async () => ({ ...server, auth }), openDiskSession: disk.open })
    const fs = new InMemoryVaultFileSystem({ rootLabel: 'Copie' })

    const job = service.downloadVault('v1', fs)
    const seen: VaultTransferProgress[] = []
    job.onProgress(p => seen.push(p))
    const result = await job.result

    expect(result).toMatchObject({ vaultId: 'v1', copied: 1, folders: 1, errors: [], cancelled: false })
    expect(server.opened).toEqual(['v1'])
    expect(disk.open).toHaveBeenCalledWith(fs, expect.objectContaining({ vaultId: 'v1', userId: 'alice' }))
    expect(seen.at(-1)?.phase).toBe('done')
    expect(job.progress.phase).toBe('done')
  })

  it('refuse un dossier qui n\'est pas vide (et n\'est pas deja un vault)', async () => {
    const server = fakeServer()
    const service = new VaultTransferService({ remote: async () => ({ ...server, auth }), openDiskSession: fakeDisk().open })
    const fs = new InMemoryVaultFileSystem({ rootLabel: 'Documents' })
    await fs.writeText('perso.txt', 'a moi')

    await expect(service.downloadVault('v1', fs).result).rejects.toThrow('pas vide')
    expect(server.opened).toEqual([])
  })

  it('reprend la session du vault actif plutot que d\'en ouvrir une autre', async () => {
    const server = fakeServer()
    const active = await server.keeper('v1')
    active.directory.add({ id: 'n1', path: 'Note.md' })
    const service = new VaultTransferService({
      remote: async () => ({ ...server, auth }),
      openDiskSession: fakeDisk().open,
      activeSession: id => (id === 'v1' ? active : undefined),
    })

    const result = await service.downloadVault('v1', new InMemoryVaultFileSystem()).result

    expect(result.copied).toBe(1)
    expect(server.opened).toEqual([])
    expect(active.getState()).toBe('connected')
  })

  it('envoie un dossier dans un nouveau vault du serveur', async () => {
    const server = fakeServer()
    const disk = fakeDisk()
    const fs = new InMemoryVaultFileSystem({ rootLabel: 'Mon vault' })
    const local = await disk.open(fs, { vaultId: 'local', token: '', userId: 'alice', onChanged: () => {} })
    local.directory.add({ id: 'n1', path: 'Note.md' })
    await settle()
    await local.dispose()
    const check = await server.keeper('v-Mon vault')
    const service = new VaultTransferService({ remote: async () => ({ ...server, auth }), openDiskSession: disk.open })

    const result = await service.uploadVault(fs, 'Mon vault').result

    expect(server.vaults.create).toHaveBeenCalledWith('alice', 'Mon vault', 't')
    expect(result).toMatchObject({ vaultId: 'v-Mon vault', copied: 1, errors: [] })
    expect(check.directory.getById('n1')?.path).toBe('Note.md')
  })

  it('ne cree aucun vault si le dossier ne s\'ouvre pas', async () => {
    const server = fakeServer()
    const service = new VaultTransferService({
      remote: async () => ({ ...server, auth }),
      openDiskSession: async () => { throw new Error('format inconnu') },
    })

    await expect(service.uploadVault(new InMemoryVaultFileSystem(), 'X').result).rejects.toThrow('format inconnu')
    expect(server.vaults.create).not.toHaveBeenCalled()
  })

  it('l\'annulation remonte dans le rapport', async () => {
    const server = fakeServer()
    const remote = await server.keeper('v1')
    for (let i = 0; i < 5; i++) remote.directory.add({ id: `n${i}`, path: `N${i}.md` })
    await settle()
    const service = new VaultTransferService({
      remote: async () => ({ ...server, auth }),
      openDiskSession: fakeDisk().open,
      transferOptions: () => ({ concurrency: 1 }),
    })

    const job = service.downloadVault('v1', new InMemoryVaultFileSystem())
    job.onProgress(p => { if (p.current) job.cancel() })
    const result = await job.result

    expect(result.cancelled).toBe(true)
    expect(result.copied).toBeLessThan(5)
  })
})
