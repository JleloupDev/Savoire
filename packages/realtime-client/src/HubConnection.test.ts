// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, expect, it } from 'vitest'
import { HubConnectionBuilder, HubConnectionState, socketUrl } from './HubConnection'

/** Fausse WebSocket : le test joue le serveur. */
class FakeSocket {
  static last: FakeSocket | null = null
  sent: any[] = []
  onmessage: ((ev: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((ev: { code: number; reason: string }) => void) | null = null
  constructor(public url: string) {
    FakeSocket.last = this
    queueMicrotask(() => this.serverSend({ t: 'hello', connectionId: 'c1' }))
  }
  send(text: string) { this.sent.push(JSON.parse(text)) }
  close(code = 1000) { queueMicrotask(() => this.onclose?.({ code, reason: '' })) }
  serverSend(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }) }
}

const okFetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch

function build(fetchImpl: typeof fetch = okFetch, reconnect = false) {
  const b = new HubConnectionBuilder().withUrl('http://srv/hubs/vault', {
    accessTokenFactory: () => 'tok',
    WebSocket: FakeSocket as any,
    fetch: fetchImpl,
  })
  if (reconnect) b.withAutomaticReconnect([0])
  return b.build()
}

describe('HubConnection', () => {
  it('builds the socket address with the token', () => {
    expect(socketUrl('https://h/hubs/sync?userId=u', 'a b')).toBe('wss://h/hubs/sync?userId=u&access_token=a+b')
    expect(socketUrl('http://h/hubs/room', '')).toBe('ws://h/hubs/room')
  })

  it('starts, invokes and receives events', async () => {
    const conn = build()
    const events: unknown[][] = []
    conn.on('InitVault', (...args) => events.push(args))
    await conn.start()
    expect(conn.state).toBe(HubConnectionState.Connected)
    expect(conn.connectionId).toBe('c1')
    const socket = FakeSocket.last!
    expect(socket.url).toContain('access_token=tok')
    const p = conn.invoke('JoinVault', 'v1')
    expect(socket.sent[0]).toMatchObject({ t: 'invoke', m: 'JoinVault', a: ['v1'] })
    socket.serverSend({ t: 'event', m: 'InitVault', a: ['v1', ['op']] })
    socket.serverSend({ t: 'result', id: socket.sent[0].id, r: ['x'] })
    await expect(p).resolves.toEqual(['x'])
    expect(events).toEqual([['v1', ['op']]])
  })

  it('rejects with the server message (HubException code kept)', async () => {
    const conn = build()
    await conn.start()
    const socket = FakeSocket.last!
    const p = conn.invoke('JoinVault', 'gone')
    socket.serverSend({ t: 'error', id: socket.sent[0].id, e: "An unexpected error occurred invoking 'JoinVault' on the server. HubException: vault-not-found" })
    await expect(p).rejects.toThrow(/HubException: vault-not-found$/)
  })

  it('reports 401 like SignalR did', async () => {
    const denied = (async () => new Response('', { status: 401 })) as unknown as typeof fetch
    const conn = build(denied)
    await expect(conn.start()).rejects.toThrow(/401/)
    expect(conn.state).toBe(HubConnectionState.Disconnected)
  })

  it('refuses to invoke when not connected', async () => {
    const conn = build()
    await expect(conn.invoke('X')).rejects.toThrow(/not in the 'Connected' State/)
  })

  it('reconnects after a drop, then closes on stop', async () => {
    const conn = build(okFetch, true)
    const seen: string[] = []
    conn.onreconnecting(() => seen.push('reconnecting'))
    conn.onreconnected(() => seen.push('reconnected'))
    conn.onclose(() => seen.push('closed'))
    await conn.start()
    const first = FakeSocket.last!
    const pending = conn.invoke('Slow')
    first.onclose?.({ code: 1006, reason: '' })
    await expect(pending).rejects.toThrow(/connection being closed/)
    await new Promise((r) => setTimeout(r, 10))
    expect(seen).toEqual(['reconnecting', 'reconnected'])
    expect(conn.state).toBe(HubConnectionState.Connected)
    await conn.stop()
    expect(conn.state).toBe(HubConnectionState.Disconnected)
    expect(seen.at(-1)).toBe('closed')
  })
})
