// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup

import { serverUrl as resolveServerUrl } from './serverAddress'
import {
  HubConnectionBuilder,
  LogLevel,
  HubConnectionState,
  type HubConnection,
} from '@savoire/realtime-client'
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

/** Serveur injoignable : nouveaux essais, de plus en plus espaces. */
const RETRY_DELAYS_MS = [2000, 5000, 15_000, 30_000]

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
  /** Document quitte (disconnect) : plus d'entree, plus de nouvel essai. */
  private left = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retries = 0

  constructor(options: SignalRTransportOptions) {
    const { serverUrl, userId = 'anon', clientId = 'anon', getToken, gone } = options
    this.clientId = clientId
    this.gone = gone
    this.connection = new HubConnectionBuilder()
      .withUrl(resolveServerUrl(`/hubs/sync?userId=${encodeURIComponent(userId)}`, serverUrl), {
        ...(getToken ? { accessTokenFactory: () => getToken() ?? '' } : {}),
        withCredentials: false,
      })
      .configureLogging(LogLevel.None)
      .withAutomaticReconnect()
      .build()
    // Apres une reconnexion, la connexion est neuve pour le serveur : elle
    // n'est plus dans le groupe du document. Sans y rentrer, plus rien
    // n'arrive en direct (ecriture d'un autre, d'une IA), alors que les
    // envois passent encore. On rentre : le serveur renvoie l'etat du document.
    this.connection.onreconnected(() => { void this.enter() })
    // Reconnexion abandonnee (serveur absent trop longtemps) : reessayer tant
    // que le document est ouvert.
    this.connection.onclose(() => { this.retryLater() })
    // Vault perdu : plus de reconnexion, plus d'envoi.
    this.unsubGone = gone?.onGone(() => { this.cancelRetry(); void this.connection.stop().catch(() => {}) }) ?? (() => {})
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
    this.left = false
    await this.enter()
  }

  /**
   * Ouvre la connexion s'il le faut, puis entre dans le document : le serveur
   * repond par InitDocument (tout le journal). Appele a l'ouverture, apres
   * chaque reconnexion, et par les nouveaux essais.
   */
  private async enter(): Promise<void> {
    if (this.left || this.gone?.gone || !this.docId) return
    try {
      if (this.connection.state === HubConnectionState.Disconnected) await this.connection.start()
    } catch (err) {
      if (this.isGone(err)) return
      console.debug('[SignalRTransport] unavailable — offline mode')
      this.retryLater()
      return
    }
    // En cours de reconnexion : onreconnected rappellera.
    if (this.connection.state !== HubConnectionState.Connected) return
    try {
      await this.connection.invoke('JoinDocument', this.vaultId, this.docId)
      this.retries = 0
    } catch (err) {
      // Refus du serveur (acces retire, document absent) : pas de nouvel essai.
      if (this.isGone(err)) return
      console.debug('[SignalRTransport] unavailable — offline mode')
    }
  }

  private retryLater(): void {
    if (this.left || this.gone?.gone || this.retryTimer) return
    const delay = RETRY_DELAYS_MS[Math.min(this.retries, RETRY_DELAYS_MS.length - 1)]!
    this.retries++
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.enter()
    }, delay)
  }

  private cancelRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
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
    this.left = true
    this.cancelRetry()
    this.unsubGone()
    await this.connection.stop()
  }
}
