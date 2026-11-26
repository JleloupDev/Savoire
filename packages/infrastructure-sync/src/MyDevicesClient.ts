// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Messages entre les appareils d'un compte, sans vault ouvert : une
// connexion au hub du vault qui ne rejoint aucun vault, juste pour recevoir
// (et envoyer) les messages ephemeres du compte (NotifyMyDevices). Sert au
// telephone, a qui une presentation en cours sur l'ordinateur propose d'etre
// sa telecommande, meme quand il est sur la liste des vaults.
import { HubConnectionBuilder, HubConnectionState, LogLevel, type HubConnection } from '@savoire/realtime-client'
import type { IMyDevices } from '@savoire/application'
import { serverUrl } from './serverAddress'

export class MyDevicesClient implements IMyDevices {
  private readonly connection: HubConnection
  private readonly callbacks = new Set<(message: Record<string, unknown>) => void>()
  private stopped = false

  constructor(base: string, getToken: () => string | null) {
    this.connection = new HubConnectionBuilder()
      .withUrl(serverUrl('/hubs/vault', base), { accessTokenFactory: () => getToken() ?? '', withCredentials: false })
      .configureLogging(LogLevel.None)
      .withAutomaticReconnect()
      .build()
    this.connection.on('MyDevicesMessage', (message: unknown) => {
      if (!message || typeof message !== 'object') return
      for (const cb of [...this.callbacks]) cb(message as Record<string, unknown>)
    })
    void this.connection.start().catch(err => console.warn('[appareils] connexion impossible', err))
  }

  async send(message: Record<string, unknown>): Promise<void> {
    if (this.stopped || this.connection.state !== HubConnectionState.Connected) return
    await this.connection.invoke('NotifyMyDevices', message)
  }

  onMessage(cb: (message: Record<string, unknown>) => void): () => void {
    this.callbacks.add(cb)
    return () => { this.callbacks.delete(cb) }
  }

  async dispose(): Promise<void> {
    this.stopped = true
    this.callbacks.clear()
    await this.connection.stop().catch(() => {})
  }
}
