// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Profil bureau unifie : vaults locaux et vaults du compte serveur dans la
// meme session de l'app. Liste composite, routage des sessions, connexion /
// deconnexion a tout moment, un seul compte a la fois.
import { describe, it, expect, vi } from 'vitest'
import type {
  AppVaultSummary, AppWorkspace, IVaultSyncSession, IVaultSyncSessionFactory, IVaultsBackend,
  VaultSyncSessionFactoryParams,
} from '@savoire/application'
import type { ISeedExportingIdentityProvider } from '@savoire/plugin-api'
import { vaultIdForPath } from '@savoire/desktop'
import {
  ServerNotConnectedError, UnifiedVaultSessionFactory, UnifiedVaultsBackend, sourceOfVault,
  type ServerAuth,
} from '../../../../../apps/web/src/createDesktopRoot'
import {
  connectToServer, serverLabel, serverStatus, type DesktopConnectionDeps,
} from '../../../../../apps/web/src/desktopConnection'
import { accountsAfterLogin } from '../../../../../apps/web/src/accountStorage'
import { setVaultFolderHost, vaultTransferActions } from '../../../../../apps/web/src/vaultTransfer'
import type { AccountEntry } from '../../../../../apps/web/src/types'

const localId = vaultIdForPath('/home/moi/Notes')
const summary = (id: string, name: string, role = 'owner'): AppVaultSummary =>
  ({ id, name, role, documentCount: 0, folderCount: 0, lastModifiedAt: null, sizeBytes: 0 })

function fakeBackend(workspace: AppWorkspace | (() => Promise<AppWorkspace>)) {
  const calls: Array<[string, ...unknown[]]> = []
  const backend: IVaultsBackend = {
    listVaults: async (userId, token) => {
      calls.push(['list', userId, token])
      return typeof workspace === 'function' ? workspace() : workspace
    },
    createVault: async (userId, name, token) => { calls.push(['create', userId, name, token]); return summary(`new-${name}`, name) },
    renameVault: async (id, name, token) => { calls.push(['rename', id, name, token]); return summary(id, name) },
    deleteVault: async (id, token) => { calls.push(['delete', id, token]) },
  }
  return { backend, calls }
}

describe('liste unifiee des vaults', () => {
  const local = () => fakeBackend({ vaults: [summary(localId, 'Notes', 'local')], sharedWithMe: [] })
  const server = () => fakeBackend({
    vaults: [summary('uuid-1', 'Equipe')],
    sharedWithMe: [{ documentId: 'd', vaultId: 'uuid-9', path: 'a.md', permission: 'read', grantedByDisplayName: 'Bob' }],
  })

  it('la source se lit sur l\'identifiant', () => {
    expect(sourceOfVault(localId)).toBe('local')
    expect(sourceOfVault('5f0c-uuid')).toBe('server')
  })

  it('hors ligne : les dossiers seuls, le serveur n\'est pas appele', async () => {
    const l = local(); const s = server()
    const unified = new UnifiedVaultsBackend(l.backend, s.backend, () => null)
    const ws = await unified.listVaults('local', 'local')
    expect(ws.vaults.map(v => v.id)).toEqual([localId])
    expect(ws.sharedWithMe).toEqual([])
    expect(s.calls).toEqual([])
  })

  it('connecte : dossiers + vaults du compte, avec le jeton du compte serveur', async () => {
    const l = local(); const s = server()
    const unified = new UnifiedVaultsBackend(l.backend, s.backend, () => ({ token: 'jwt', userId: 'u1' }))
    const ws = await unified.listVaults('local', 'local')
    expect(ws.vaults.map(v => v.id)).toEqual([localId, 'uuid-1'])
    expect(ws.sharedWithMe).toHaveLength(1)
    expect(s.calls).toEqual([['list', 'u1', 'jwt']])
  })

  it('serveur injoignable : les dossiers restent, l\'erreur est gardee', async () => {
    const l = local()
    const s = fakeBackend(() => Promise.reject(new TypeError('Failed to fetch')))
    let auth: ServerAuth | null = { token: 'jwt', userId: 'u1' }
    const unified = new UnifiedVaultsBackend(l.backend, s.backend, () => auth)
    const ws = await unified.listVaults('local', 'local')
    expect(ws.vaults.map(v => v.id)).toEqual([localId])
    expect(unified.serverError()).toBeInstanceOf(TypeError)
    auth = null
    await unified.listVaults('local', 'local')
    expect(unified.serverError()).toBeNull()
  })

  it('creer, renommer, supprimer : chacun chez sa source', async () => {
    const l = local(); const s = server()
    const unified = new UnifiedVaultsBackend(l.backend, s.backend, () => ({ token: 'jwt', userId: 'u1' }))
    await unified.createVaultOn('server', 'Projet')
    await unified.createVaultOn('local', 'Perso')
    await unified.renameVault('uuid-1', 'Equipe 2', 'local')
    await unified.renameVault(localId, 'Notes 2', 'local')
    await unified.deleteVault('uuid-1', 'local')
    await unified.deleteVault(localId, 'local')
    expect(s.calls).toEqual([
      ['create', 'u1', 'Projet', 'jwt'],
      ['rename', 'uuid-1', 'Equipe 2', 'jwt'],
      ['delete', 'uuid-1', 'jwt'],
    ])
    expect(l.calls.map(c => c[0])).toEqual(['create', 'rename', 'delete'])
  })

  it('sans compte connecte, rien ne part vers le serveur', async () => {
    const s = server()
    const unified = new UnifiedVaultsBackend(local().backend, s.backend, () => null)
    await expect(unified.createVaultOn('server', 'X')).rejects.toBeInstanceOf(ServerNotConnectedError)
    await expect(unified.deleteVault('uuid-1', 'local')).rejects.toBeInstanceOf(ServerNotConnectedError)
    expect(s.calls).toEqual([])
  })
})

describe('routage des sessions', () => {
  const params = (vaultId: string): VaultSyncSessionFactoryParams =>
    ({ vaultId, token: 'local', userId: 'local', onChanged: () => {}, identitySeed: new Uint8Array([1]) })

  function setup(auth: () => ServerAuth | null) {
    const diskSession = { kind: 'disk' } as unknown as IVaultSyncSession
    const serverSession = { kind: 'server' } as unknown as IVaultSyncSession
    const disk: IVaultSyncSessionFactory = { open: vi.fn(async () => diskSession) }
    const server: IVaultSyncSessionFactory = { open: vi.fn(async () => serverSession) }
    const seed = new Uint8Array([7, 7])
    const identity = { exportSignSeed: () => seed } as unknown as ISeedExportingIdentityProvider
    const identityOf = vi.fn(async () => identity)
    const factory = new UnifiedVaultSessionFactory(disk, server, auth, identityOf)
    return { factory, disk, server, diskSession, serverSession, identity, identityOf, seed }
  }

  it('un dossier -> session sur disque, parametres intacts', async () => {
    const t = setup(() => ({ token: 'jwt', userId: 'u1' }))
    const p = params(localId)
    expect(await t.factory.open(p)).toBe(t.diskSession)
    expect(vi.mocked(t.disk.open).mock.calls[0][0]).toBe(p)
    expect(t.server.open).not.toHaveBeenCalled()
  })

  it('un vault du serveur -> session serveur avec le compte connecte et son identite', async () => {
    const t = setup(() => ({ token: 'jwt', userId: 'u1' }))
    expect(await t.factory.open(params('uuid-1'))).toBe(t.serverSession)
    const passed = vi.mocked(t.server.open).mock.calls[0][0]
    expect(passed).toMatchObject({ vaultId: 'uuid-1', token: 'jwt', userId: 'u1', identity: t.identity, identitySeed: t.seed })
    expect(t.identityOf).toHaveBeenCalledWith({ token: 'jwt', userId: 'u1' })
  })

  it('les deux, l\'un apres l\'autre, sans rien recreer', async () => {
    const t = setup(() => ({ token: 'jwt', userId: 'u1' }))
    expect(await t.factory.open(params(localId))).toBe(t.diskSession)
    expect(await t.factory.open(params('uuid-1'))).toBe(t.serverSession)
    expect(await t.factory.open(params(localId))).toBe(t.diskSession)
  })

  it('hors ligne : un vault du serveur ne s\'ouvre pas, un dossier si', async () => {
    const t = setup(() => null)
    await expect(t.factory.open(params('uuid-1'))).rejects.toBeInstanceOf(ServerNotConnectedError)
    expect(await t.factory.open(params(localId))).toBe(t.diskSession)
  })
})

describe('connexion au serveur a tout moment, un seul compte', () => {
  const account = (userId: string): AccountEntry =>
    ({ userId, email: `${userId}@x.fr`, displayName: userId, refreshToken: `rt-${userId}`, isActive: true })

  function setup(state: { server: string | null; account: AccountEntry | null; token: string | null }, opts: {
    known?: string[]
    loginError?: unknown
  } = {}) {
    const log: string[] = []
    const deps: DesktopConnectionDeps = {
      current: () => ({ ...state }),
      knownServers: () => opts.known ?? (state.server ? [state.server] : []),
      chooseServer: async (input) => { log.push(`choose ${input}`); state.server = input; return input },
      login: async (email) => {
        log.push(`login ${email}`)
        if (opts.loginError) throw opts.loginError
        state.account = account(email.split('@')[0]); state.token = 'new-jwt'
      },
      revoke: async (server, token, refresh) => { log.push(`revoke ${server} ${token} ${refresh}`) },
      clearSession: async (server) => { log.push(`clear ${server}`) },
      forget: async (server) => { log.push(`forget ${server}`) },
    }
    return { deps, log, state }
  }

  it('premiere connexion : choisit le serveur puis connecte', async () => {
    const { deps, log } = setup({ server: null, account: null, token: null })
    expect(await connectToServer(deps, '127.0.0.1:5000', ' bob@x.fr ', 'pw')).toBe('https://127.0.0.1:5000')
    expect(log).toEqual(['choose https://127.0.0.1:5000', 'login bob@x.fr'])
  })

  it('autre compte, meme serveur : le precedent est revoque, pas d\'effacement de session', async () => {
    const { deps, log } = setup({ server: 'http://s1', account: account('alice'), token: 'jwt-a' })
    await connectToServer(deps, 'http://s1', 'bob@x.fr', 'pw')
    expect(log).toEqual(['choose http://s1', 'login bob@x.fr', 'revoke http://s1 jwt-a rt-alice'])
  })

  it('autre serveur : le compte precedent est revoque sur SON serveur et sa session effacee', async () => {
    const { deps, log, state } = setup({ server: 'http://s1', account: account('alice'), token: 'jwt-a' })
    await connectToServer(deps, 'http://s2', 'bob@x.fr', 'pw')
    expect(log).toEqual(['choose http://s2', 'login bob@x.fr', 'revoke http://s1 jwt-a rt-alice', 'clear http://s1'])
    expect(state.account?.userId).toBe('bob')
  })

  it('echec : retour au serveur d\'avant, le compte d\'avant reste', async () => {
    const { deps, log, state } = setup({ server: 'http://s1', account: account('alice'), token: 'jwt-a' }, {
      known: ['http://s1', 'http://s2'], loginError: new Error('401'),
    })
    await expect(connectToServer(deps, 'http://s2', 'bob@x.fr', 'bad')).rejects.toThrow('401')
    expect(log).toEqual(['choose http://s2', 'login bob@x.fr', 'choose http://s1'])
    expect(state).toMatchObject({ server: 'http://s1', token: 'jwt-a' })
  })

  it('adresse neuve injoignable : elle n\'est pas gardee', async () => {
    const { deps, log } = setup({ server: null, account: null, token: null }, { loginError: new TypeError('Failed to fetch') })
    await expect(connectToServer(deps, 'http://nulle-part', 'bob@x.fr', 'pw')).rejects.toBeInstanceOf(TypeError)
    expect(log).toEqual(['choose http://nulle-part', 'login bob@x.fr', 'forget http://nulle-part'])
  })

  it('adresse invalide : rien ne bouge', async () => {
    const { deps, log } = setup({ server: 'http://s1', account: account('alice'), token: 'jwt-a' })
    await expect(connectToServer(deps, 'ftp://x', 'bob@x.fr', 'pw')).rejects.toThrow(/http/)
    expect(log).toEqual([])
  })

  it('un seul compte garde sur le bureau, plusieurs dans le navigateur', () => {
    const alice = account('alice'); const bob = account('bob')
    expect(accountsAfterLogin([alice], bob, true)).toEqual([bob])
    expect(accountsAfterLogin([alice], bob, false)).toEqual([{ ...alice, isActive: false }, bob])
    expect(accountsAfterLogin([{ ...bob, refreshToken: 'old' }], bob, false)).toEqual([bob])
  })

  it('etat du bouton serveur', () => {
    const alice = account('alice')
    expect(serverStatus('http://127.0.0.1:5000', alice, 'jwt')).toMatchObject({ state: 'connected', label: '127.0.0.1:5000 · alice' })
    expect(serverStatus('https://s.fr', alice, null)).toMatchObject({ state: 'offline', label: 'Hors ligne · s.fr' })
    expect(serverStatus(null, null, null)).toMatchObject({ state: 'none', label: 'Hors ligne · non connecté' })
    expect(serverLabel('https://s.fr/savoire')).toBe('s.fr/savoire')
  })
})

describe('transfert selon la source du vault (bureau)', () => {
  it('vault du serveur : telecharger ; vault local : envoyer', () => {
    setVaultFolderHost({
      createDownloadFolder: async () => null,
      fileSystemOf: async () => { throw new Error('non') },
      openDiskSession: async () => { throw new Error('non') },
      remote: async () => { throw new Error('non') },
    })
    const actions = vaultTransferActions({
      profile: 'desktop',
      appRemote: async () => { throw new Error('non') },
      activeSession: () => undefined,
      syncKindOf: () => 'crdt',
      show: () => {},
      refreshVaults: () => {},
      onError: () => {},
    })
    const local = { id: localId, name: 'Notes', role: 'local', documentCount: 0, folderCount: 0, locked: false, source: 'local' }
    const remote = { ...local, id: 'uuid-1', source: 'server' }
    expect(actions?.download?.appliesTo?.(remote)).toBe(true)
    expect(actions?.download?.appliesTo?.(local)).toBe(false)
    expect(actions?.upload?.appliesTo?.(local)).toBe(true)
    expect(actions?.upload?.appliesTo?.(remote)).toBe(false)
    setVaultFolderHost(null)
  })
})
