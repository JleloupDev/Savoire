// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// `sync.openRoom` des plugins, servi par la session du vault actif.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { SessionSyncAPI, type IVaultSyncSession } from '@savoire/application'
import type { DocumentRoom, SyncAPI } from '@savoire/plugin-api'
import { InProcessPeerBus, LocalPeerVaultSessionFactory } from '@savoire/infrastructure-sync'

const SETTLE_MS = 5
const settle = () => new Promise(r => setTimeout(r, SETTLE_MS * 4))

describe('SessionSyncAPI', () => {
  const factory = new LocalPeerVaultSessionFactory(new InProcessPeerBus(), { settleMs: SETTLE_MS })
  const sessions: IVaultSyncSession[] = []
  const open = async (userId: string) => {
    const s = await factory.open({ vaultId: 'v1', token: '', userId, onChanged: () => {} })
    sessions.push(s)
    return new SessionSyncAPI(() => s)
  }

  afterEach(async () => {
    for (const s of sessions.splice(0)) await s.dispose()
  })

  it('un snapshot pousse par un plugin arrive au plugin de l\'autre pair', async () => {
    const roomA = await (await open('alice')).openRoom('v1', 'd1', 'alice')
    const roomB = await (await open('bob')).openRoom('v1', 'd1', 'bob')
    const received: [string, string][] = []
    roomB.onSnapshot((json, from) => received.push([json, from]))
    await roomA.pushSnapshot('{"a":1}')
    await settle()
    expect(received).toEqual([['{"a":1}', 'alice']])
  })

  it('une room fermee ne recoit plus rien et n\'emet plus rien', async () => {
    const roomA = await (await open('alice')).openRoom('v1', 'd1', 'alice')
    const roomB = await (await open('bob')).openRoom('v1', 'd1', 'bob')
    const received: string[] = []
    roomB.onSnapshot(json => received.push(json))
    await roomB.close()
    await roomA.pushSnapshot('ignore')
    await settle()
    expect(received).toEqual([])
  })

  it('sans session de vault, retombe sur la room directe', async () => {
    const room = {} as DocumentRoom
    const fallback: SyncAPI = { openRoom: vi.fn(async () => room) }
    const api = new SessionSyncAPI(() => undefined, fallback)
    expect(await api.openRoom('v1', 'd1', 'u')).toBe(room)
    expect(fallback.openRoom).toHaveBeenCalledWith('v1', 'd1', 'u')
  })

  it('sans session ni repli, echoue clairement', async () => {
    const api = new SessionSyncAPI(() => undefined)
    await expect(api.openRoom('v1', 'd1', 'u')).rejects.toThrow('aucune session de vault active')
  })
})
