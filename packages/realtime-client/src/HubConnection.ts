// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Client des hubs temps reel du serveur Savoire (WebSocket, trames JSON).
//
// Le serveur Rust a remplace SignalR par un protocole plus simple (voir
// docs/Architecture/realtime-protocol.md). Ce client garde la forme de
// l'API de @microsoft/signalr dont l'application se servait : builder,
// start/stop, invoke/send, on/off, onclose/onreconnecting/onreconnected,
// etats, reconnexion automatique. Le code qui l'utilise n'a change que son
// import.
//
// Un refus attendu du serveur garde le meme texte qu'avec SignalR :
// « An unexpected error occurred invoking 'X' on the server. HubException: vault-not-found ».

export enum HubConnectionState {
  Disconnected = 'Disconnected',
  Connecting = 'Connecting',
  Connected = 'Connected',
  Disconnecting = 'Disconnecting',
  Reconnecting = 'Reconnecting',
}

/** Garde pour compatibilite : ce client ne journalise rien. */
export enum LogLevel {
  Trace = 0,
  Debug = 1,
  Information = 2,
  Warning = 3,
  Error = 4,
  Critical = 5,
  None = 6,
}

export interface HubConnectionOptions {
  /** Jeton presente au serveur (parametre access_token de la WebSocket). */
  accessTokenFactory?: () => string | Promise<string>
  /** Sans effet : aucun cookie n'est envoye. Garde pour compatibilite. */
  withCredentials?: boolean
  /** Constructeur WebSocket (tests, environnements sans WebSocket global). */
  WebSocket?: WebSocketConstructor
  /** fetch utilise pour verifier le jeton avant d'ouvrir la WebSocket. */
  fetch?: typeof fetch
}

type WebSocketConstructor = new (url: string) => WebSocket

type Handler = (...args: any[]) => void

interface Pending {
  resolve: (value: any) => void
  reject: (err: Error) => void
}

const DEFAULT_RETRY_DELAYS = [0, 2000, 10000, 30000]
const KEEP_ALIVE_MS = 15_000
const SERVER_TIMEOUT_MS = 30_000

export class HubConnectionBuilder {
  private url = ''
  private options: HubConnectionOptions = {}
  private retryDelays: number[] | null = null

  withUrl(url: string, options: HubConnectionOptions = {}): this {
    this.url = url
    this.options = options
    return this
  }

  configureLogging(_level: LogLevel | unknown): this {
    return this
  }

  withAutomaticReconnect(retryDelays: number[] = DEFAULT_RETRY_DELAYS): this {
    this.retryDelays = [...retryDelays]
    return this
  }

  build(): HubConnection {
    if (!this.url) throw new Error("L'adresse du hub manque (withUrl).")
    return new HubConnection(this.url, this.options, this.retryDelays)
  }
}

/** Adresse WebSocket d'un hub : http(s) -> ws(s), jeton en access_token. */
export function socketUrl(url: string, token: string, base?: string): string {
  const origin = base ?? (typeof location !== 'undefined' ? location.href : 'http://localhost/')
  const u = new URL(url, origin)
  u.protocol = u.protocol === 'https:' ? 'wss:' : u.protocol === 'http:' ? 'ws:' : u.protocol
  if (token) u.searchParams.set('access_token', token)
  return u.toString()
}

function httpUrl(url: string): string {
  const origin = typeof location !== 'undefined' ? location.href : 'http://localhost/'
  const u = new URL(url, origin)
  if (u.protocol === 'wss:') u.protocol = 'https:'
  if (u.protocol === 'ws:') u.protocol = 'http:'
  return u.toString()
}

export class HubConnection {
  private _state = HubConnectionState.Disconnected
  private socket: WebSocket | null = null
  private nextId = 1
  private readonly pending = new Map<string, Pending>()
  private readonly handlers = new Map<string, Handler[]>()
  private readonly closeCallbacks: Array<(err?: Error) => void> = []
  private readonly reconnectingCallbacks: Array<(err?: Error) => void> = []
  private readonly reconnectedCallbacks: Array<(connectionId?: string) => void> = []
  private _connectionId: string | null = null
  private stopRequested = false
  private keepAlive: ReturnType<typeof setInterval> | null = null
  private lastMessageAt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private stopPromise: Promise<void> | null = null

  constructor(
    private readonly url: string,
    private readonly options: HubConnectionOptions,
    private readonly retryDelays: number[] | null,
  ) {}

  get state(): HubConnectionState {
    return this._state
  }

  get connectionId(): string | null {
    return this._connectionId
  }

  on(name: string, handler: Handler): void {
    const key = name.toLowerCase()
    const list = this.handlers.get(key) ?? []
    if (!list.includes(handler)) list.push(handler)
    this.handlers.set(key, list)
  }

  off(name: string, handler?: Handler): void {
    const key = name.toLowerCase()
    if (!handler) {
      this.handlers.delete(key)
      return
    }
    const list = (this.handlers.get(key) ?? []).filter((h) => h !== handler)
    if (list.length) this.handlers.set(key, list)
    else this.handlers.delete(key)
  }

  onclose(cb: (err?: Error) => void): void {
    this.closeCallbacks.push(cb)
  }

  onreconnecting(cb: (err?: Error) => void): void {
    this.reconnectingCallbacks.push(cb)
  }

  onreconnected(cb: (connectionId?: string) => void): void {
    this.reconnectedCallbacks.push(cb)
  }

  async start(): Promise<void> {
    if (this._state !== HubConnectionState.Disconnected) {
      throw new Error("Cannot start a HubConnection that is not in the 'Disconnected' state.")
    }
    this.stopRequested = false
    this._state = HubConnectionState.Connecting
    try {
      await this.open()
      this._state = HubConnectionState.Connected
    } catch (err) {
      this._state = HubConnectionState.Disconnected
      throw err
    }
  }

  async stop(): Promise<void> {
    this.stopRequested = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this._state === HubConnectionState.Disconnected) return
    if (this._state === HubConnectionState.Reconnecting && !this.socket) {
      this.finishClose(undefined)
      return
    }
    if (this.stopPromise) return this.stopPromise
    this._state = HubConnectionState.Disconnecting
    this.stopPromise = new Promise<void>((resolve) => {
      const socket = this.socket
      if (!socket) {
        this.finishClose(undefined)
        resolve()
        return
      }
      const done = () => resolve()
      this.closeCallbacks.push(function once() { done() })
      try { socket.close(1000) } catch { this.handleSocketClosed(undefined) }
    })
    try {
      await this.stopPromise
    } finally {
      this.stopPromise = null
    }
  }

  invoke<T = any>(method: string, ...args: any[]): Promise<T> {
    if (this._state !== HubConnectionState.Connected || !this.socket) {
      return Promise.reject(new Error("Cannot send data if the connection is not in the 'Connected' State."))
    }
    const id = String(this.nextId++)
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        this.socket!.send(JSON.stringify({ t: 'invoke', id, m: method, a: args }))
      } catch (err) {
        this.pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  async send(method: string, ...args: any[]): Promise<void> {
    if (this._state !== HubConnectionState.Connected || !this.socket) {
      throw new Error("Cannot send data if the connection is not in the 'Connected' State.")
    }
    this.socket.send(JSON.stringify({ t: 'invoke', m: method, a: args }))
  }

  // ── Interne ────────────────────────────────────────────────────────────────

  private async token(): Promise<string> {
    return (await this.options.accessTokenFactory?.()) ?? ''
  }

  /** Ouvre la WebSocket ; resout au message « hello » du serveur. */
  private async open(): Promise<void> {
    const token = await this.token()
    // Un jeton refuse se dit avant l'ouverture (un navigateur ne montre pas
    // le statut d'une WebSocket refusee) : meme texte qu'avec SignalR.
    const f = this.options.fetch ?? (typeof fetch !== 'undefined' ? fetch : undefined)
    if (f) {
      let res: Response | undefined
      try {
        res = await f(httpUrl(this.url), { method: 'GET', headers: token ? { Authorization: `Bearer ${token}` } : {}, credentials: 'omit' })
      } catch (err) {
        throw new Error(`Failed to complete negotiation with the server: ${String(err)}`)
      }
      if (res.status === 401) {
        throw new Error("Failed to complete negotiation with the server: Error: Unauthorized: Status code '401'")
      }
      if (!res.ok) {
        throw new Error(`Failed to complete negotiation with the server: Error: Status code '${res.status}'`)
      }
    }
    const Ws = this.options.WebSocket ?? (globalThis as any).WebSocket
    if (!Ws) throw new Error("Aucune WebSocket dans cet environnement.")
    const socket: WebSocket = new Ws(socketUrl(this.url, token))
    this.socket = socket
    await new Promise<void>((resolve, reject) => {
      let opened = false
      socket.onmessage = (ev: MessageEvent) => {
        this.lastMessageAt = Date.now()
        let frame: any
        try { frame = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)) } catch { return }
        if (!opened && frame?.t === 'hello') {
          opened = true
          this._connectionId = frame.connectionId ?? null
          this.startKeepAlive()
          resolve()
          return
        }
        this.handleFrame(frame)
      }
      socket.onerror = () => {
        if (!opened) {
          opened = true
          this.socket = null
          reject(new Error('WebSocket failed to connect.'))
        }
      }
      socket.onclose = (ev: CloseEvent) => {
        if (!opened) {
          opened = true
          this.socket = null
          reject(new Error(`WebSocket closed with status code: ${ev.code}.`))
          return
        }
        this.handleSocketClosed(ev.code === 1000 || ev.code === 1005 ? undefined : new Error(`WebSocket closed with status code: ${ev.code} (${ev.reason || 'no reason given'}).`))
      }
    })
  }

  private startKeepAlive(): void {
    this.stopKeepAlive()
    this.lastMessageAt = Date.now()
    this.keepAlive = setInterval(() => {
      if (!this.socket) return
      if (Date.now() - this.lastMessageAt > SERVER_TIMEOUT_MS) {
        try { this.socket.close(4000, 'Server timeout elapsed without receiving a message from the server.') } catch { /* deja ferme */ }
        return
      }
      try { this.socket.send(JSON.stringify({ t: 'ping' })) } catch { /* ferme entre-temps */ }
    }, KEEP_ALIVE_MS)
  }

  private stopKeepAlive(): void {
    if (this.keepAlive) clearInterval(this.keepAlive)
    this.keepAlive = null
  }

  private handleFrame(frame: any): void {
    switch (frame?.t) {
      case 'result': {
        const p = this.pending.get(String(frame.id))
        if (!p) return
        this.pending.delete(String(frame.id))
        p.resolve(frame.r ?? null)
        return
      }
      case 'error': {
        const p = this.pending.get(String(frame.id))
        if (!p) return
        this.pending.delete(String(frame.id))
        p.reject(new Error(String(frame.e ?? 'Error')))
        return
      }
      case 'event': {
        const list = this.handlers.get(String(frame.m ?? '').toLowerCase())
        if (!list) return
        const args = Array.isArray(frame.a) ? frame.a : []
        for (const h of [...list]) {
          try { h(...args) } catch (err) { console.error(`[hub] handler '${frame.m}' failed`, err) }
        }
        return
      }
      default:
        return
    }
  }

  private rejectPending(err: Error): void {
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
  }

  private handleSocketClosed(err?: Error): void {
    this.stopKeepAlive()
    this.socket = null
    this.rejectPending(new Error('Invocation canceled due to the underlying connection being closed.'))
    if (this.stopRequested || !this.retryDelays || this._state === HubConnectionState.Disconnecting) {
      this.finishClose(err)
      return
    }
    void this.reconnect(err)
  }

  private finishClose(err?: Error): void {
    this._state = HubConnectionState.Disconnected
    this._connectionId = null
    for (const cb of [...this.closeCallbacks]) {
      try { cb(err) } catch (e) { console.error('[hub] onclose failed', e) }
    }
  }

  private async reconnect(err?: Error): Promise<void> {
    this._state = HubConnectionState.Reconnecting
    for (const cb of [...this.reconnectingCallbacks]) {
      try { cb(err) } catch (e) { console.error('[hub] onreconnecting failed', e) }
    }
    let lastError = err
    for (const delay of this.retryDelays ?? []) {
      await new Promise<void>((resolve) => { this.reconnectTimer = setTimeout(resolve, delay) })
      this.reconnectTimer = null
      if (this.stopRequested) return
      try {
        await this.open()
        if (this.stopRequested) {
          try { this.socket?.close(1000) } catch { /* rien */ }
          return
        }
        this._state = HubConnectionState.Connected
        for (const cb of [...this.reconnectedCallbacks]) {
          try { cb(this._connectionId ?? undefined) } catch (e) { console.error('[hub] onreconnected failed', e) }
        }
        return
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e))
      }
    }
    this.finishClose(lastError)
  }
}
