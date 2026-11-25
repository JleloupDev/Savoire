// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Telecommande d'une presentation (apps/web/src/slideRemote.ts) : l'adresse
// lue et gardee le temps de la connexion, l'origine montree au telephone, le
// lien sur la room de la note (messages dans la presence, par session).
import { describe, it, expect, vi } from 'vitest'
import type { DocumentRoom, DocumentRoomPresence, SyncAPI } from '@savoire/plugin-api'
import { openRemoteLink, readSlideRemote, remoteOrigin } from '../../../../../apps/web/src/slideRemote'

function memoryStore() {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, map: m }
}

describe('telecommande : adresse', () => {
  it('lit l adresse, la garde, et la retrouve apres le retour de connexion sur /', () => {
    const store = memoryStore()
    expect(readSlideRemote('?window=remote&vault=v1&note=d1&session=s1', store)).toEqual({ vaultId: 'v1', docId: 'd1', session: 's1' })
    expect(readSlideRemote('', store)).toEqual({ vaultId: 'v1', docId: 'd1', session: 's1' })
    expect(readSlideRemote('?window=remote&vault=v1', memoryStore())).toBeNull()
    expect(readSlideRemote('', memoryStore())).toBeNull()
    // Trop vieux : oublie.
    store.setItem('savoire-slide-remote', JSON.stringify({ vaultId: 'v1', docId: 'd1', session: 's1', at: Date.now() - 4 * 3600_000 }))
    expect(readSlideRemote('', store)).toBeNull()
  })

  it('montre au telephone l adresse de la page, ou celle du serveur dans l appli de bureau', () => {
    expect(remoteOrigin('https://srv', { protocol: 'https:', hostname: 'savoire.fr', origin: 'https://savoire.fr' })).toBe('https://savoire.fr')
    expect(remoteOrigin('https://srv', { protocol: 'tauri:', hostname: 'localhost', origin: 'tauri://localhost' })).toBe('https://srv')
    expect(remoteOrigin('https://srv', { protocol: 'http:', hostname: 'tauri.localhost', origin: 'http://tauri.localhost' })).toBe('https://srv')
  })
})

describe('telecommande : lien sur la room de la note', () => {
  it('envoie dans la presence et ne rend que les messages de sa session', async () => {
    let listener: ((u: string, p: DocumentRoomPresence) => void) | null = null
    const sent: DocumentRoomPresence[] = []
    const room = {
      updatePresence: vi.fn(async (p: DocumentRoomPresence) => { sent.push(p) }),
      onPresence: (cb: (u: string, p: DocumentRoomPresence) => void) => { listener = cb; return () => {} },
      close: vi.fn(async () => {}),
    } as unknown as DocumentRoom
    const sync: SyncAPI = { openRoom: vi.fn(async () => room) }
    const link = openRemoteLink({ sync, vaultId: 'v', docId: 'd', userId: 'u', session: 's1', url: 'https://x/?session=s1', local: false })
    // Avant la room : l'ordre attend, puis part.
    link.send({ role: 'remote', session: 's1', seq: 1, cmd: 'hello' })
    const got: unknown[] = []
    link.onMessage(m => got.push(m))
    await new Promise(r => setTimeout(r, 0))
    expect(sync.openRoom).toHaveBeenCalledWith('v', 'd', 'u')
    expect(sent).toEqual([{ userId: 'u', slides: { role: 'remote', session: 's1', seq: 1, cmd: 'hello' } }])
    listener!('u', { userId: 'u', slides: { role: 'screen', session: 's1', index: 2 } })
    listener!('u', { userId: 'u', slides: { role: 'screen', session: 'autre', index: 9 } })
    listener!('u', { userId: 'u', cursor: 3 })
    expect(got).toEqual([{ role: 'screen', session: 's1', index: 2 }])
    link.close()
    await new Promise(r => setTimeout(r, 350))
    expect(room.close).toHaveBeenCalled()
  })
})
