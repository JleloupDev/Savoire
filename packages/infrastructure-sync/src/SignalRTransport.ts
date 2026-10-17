// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup

import {
  HubConnectionBuilder,
  LogLevel,
  HubConnectionState,
  type HubConnection,
} from '@microsoft/signalr'
import type { ITransport } from '@savoire/plugin-api'
import type { VaultGoneSignal } from './vaultGone'

export interface SignalRTransportOptions {
  serverUrl: string
  userId?: string
  clientId?: string
  getToken?: () => string | null
  /** Signal du vault : « vault-not-found » l'allume, et le transport s'arrete. */
  gone?: VaultGoneSignal
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 8192
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
}

export class SignalRTransport implements ITransport {
  private readonly connection: HubConnection
  private readonly clientId: string
  private vaultId = ''
  private docId = ''
  private readonly gone: VaultGoneSignal | undefined
  private readonly unsubGone: () => void

  constructor(options: SignalRTransportOptions) {
    const { serverUrl, userId = 'anon', clientId = 'anon', getToken, gone } = options
    this.clientId = clientId
    this.gone = gone
    this.connection = new HubConnectionBuilder()
      .withUrl(`${serverUrl}/hubs/sync?userId=${encodeURIComponent(userId)}`, {
        ...(getToken ? { accessTokenFactory: () => getToken() ?? '' } : {}),
      })
      .configureLogging(LogLevel.None)
      .withAutomaticReconnect()
      .build()
    // Vault perdu : plus de reconnexion, plus d'envoi.
    this.unsubGone = gone?.onGone(() => { void this.connection.stop().catch(() => {}) }) ?? (() => {})
  }

  /** Rapporte l'erreur au signal du vault ; rend true si le vault est perdu. */
  private isGone(err: unknown): boolean {
    return this.gone?.check(err) ?? false
  }

  private report = (err: unknown): void => {
    if (!this.isGone(err)) console.error(err)
  }

  async join(vaultId: string, docId: string): Promise<void> {
    this.vaultId = vaultId
    this.docId = docId
    if (this.gone?.gone) return
    try {
      await this.connection.start()
      await this.connection.invoke('JoinDocument', vaultId, docId)
    } catch (err) {
      if (this.isGone(err)) return
      console.debug('[SignalRTransport] unavailable — offline mode')
    }
  }

  async push(op: Uint8Array): Promise<void> {
    if (this.connection.state !== HubConnectionState.Connected) return
    await this.connection
      .invoke('PushOperation', this.vaultId, this.docId, this.clientId, toBase64(op))
      .catch(this.report)
  }

  async pushSnapshot(snapshot: Uint8Array): Promise<void> {
    if (this.connection.state !== HubConnectionState.Connected) return
    await this.connection
      .invoke('SnapshotDocument', this.vaultId, this.docId, toBase64(snapshot))
      .catch(this.report)
  }

  async pushPresence(bytes: Uint8Array): Promise<void> {
    if (this.connection.state !== HubConnectionState.Connected) return
    await this.connection
      .invoke('UpdateAwareness', this.vaultId, this.docId, toBase64(bytes))
      .catch(this.report)
  }

  onInit(cb: (ops: Uint8Array[]) => void): () => void {
    const handler = (_docId: string, base64Ops: string[]) => {
      cb(base64Ops.map(fromBase64))
    }
    this.connection.on('InitDocument', handler)
    return () => this.connection.off('InitDocument', handler)
  }

  onRemoteOp(cb: (op: Uint8Array) => void): () => void {
    const handler = (_docId: string, _clientId: string, base64: string) => {
      cb(fromBase64(base64))
    }
    this.connection.on('ReceiveOperation', handler)
    return () => this.connection.off('ReceiveOperation', handler)
  }

  onRemotePresence(cb: (bytes: Uint8Array) => void): () => void {
    const handler = (_docId: string, base64: string) => {
      cb(fromBase64(base64))
    }
    this.connection.on('AwarenessUpdated', handler)
    return () => this.connection.off('AwarenessUpdated', handler)
  }

  getState(): 'connected' | 'connecting' | 'disconnected' {
    switch (this.connection.state) {
      case HubConnectionState.Connected:    return 'connected'
      case HubConnectionState.Connecting:
      case HubConnectionState.Reconnecting: return 'connecting'
      default:                              return 'disconnected'
    }
  }

  async disconnect(): Promise<void> {
    this.unsubGone()
    await this.connection.stop()
  }
}
