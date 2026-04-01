// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup

import * as Y from 'yjs'
import {
  HubConnection,
  HubConnectionBuilder,
  HubConnectionState,
} from '@microsoft/signalr'
import type { IDocumentFetcher } from '@savoire/platform'
import { base64ToBytes } from './base64'

function defaultConnectionFactory(
  serverUrl: string,
  getToken: () => string | null,
  userId: string,
): HubConnection {
  return new HubConnectionBuilder()
    .withUrl(`${serverUrl}/hubs/sync?userId=${encodeURIComponent(userId)}`, {
      accessTokenFactory: () => getToken() ?? '',
    })
    .withAutomaticReconnect()
    .build()
}

export interface CrdtDocumentFetcherOptions {
  serverUrl?: string
  getToken?: () => string | null
  getUserId?: () => string
  /** Injecté en test pour remplacer HubConnectionBuilder. */
  connectionFactory?: (serverUrl: string, getToken: () => string | null, userId: string) => HubConnection
}

interface DocEntry {
  ydoc: Y.Doc
  ready: boolean
  initPromise: Promise<void>
  resolveInit: () => void
}

export class CrdtDocumentFetcher implements IDocumentFetcher {
  private readonly serverUrl: string
  private readonly getToken: () => string | null
  private readonly getUserId: () => string
  private readonly connectionFactory: (serverUrl: string, getToken: () => string | null, userId: string) => HubConnection
  private connection: HubConnection | null = null
  private readonly docs = new Map<string, DocEntry>()

  constructor(options: CrdtDocumentFetcherOptions = {}) {
    this.serverUrl = options.serverUrl ?? ''
    this.getToken = options.getToken ?? (() => null)
    this.getUserId = options.getUserId ?? (() => 'reader')
    this.connectionFactory = options.connectionFactory ?? defaultConnectionFactory
  }

  async getDocumentContent(vaultId: string, docId: string, _token: string): Promise<string> {
    const existing = this.docs.get(docId)
    if (existing) {
      if (!existing.ready) await existing.initPromise
      return existing.ydoc.getText('codemirror').toString()
    }

    const ydoc = new Y.Doc()
    let resolveInit!: () => void
    const initPromise = new Promise<void>(r => { resolveInit = r })
    const entry: DocEntry = { ydoc, ready: false, initPromise, resolveInit }
    this.docs.set(docId, entry)

    const conn = await this.ensureConnection()
    await conn.invoke('JoinDocument', vaultId, docId)

    await initPromise
    return ydoc.getText('codemirror').toString()
  }

  async writeDocumentContent(_vaultId: string, _docId: string, _content: string, _token: string): Promise<void> {
    // CRDT documents are written via Yjs ops, not REST. This method is intentionally a no-op.
  }

  private async ensureConnection(): Promise<HubConnection> {
    if (this.connection && this.connection.state !== HubConnectionState.Disconnected) {
      return this.connection
    }

    const userId = this.getUserId()
    this.connection = this.connectionFactory(this.serverUrl, this.getToken, userId)

    this.connection.on('InitDocument', (docId: string, opsBase64: string[]) => {
      const entry = this.docs.get(docId)
      if (!entry) return
      for (const opBase64 of opsBase64) {
        try { Y.applyUpdate(entry.ydoc, base64ToBytes(opBase64)) }
        catch { /* POC: ignoré — op corrompue */ }
      }
      entry.ready = true
      entry.resolveInit()
    })

    this.connection.on('ReceiveOperation', (docId: string, _clientId: string, opBase64: string) => {
      const entry = this.docs.get(docId)
      if (!entry?.ready) return
      try { Y.applyUpdate(entry.ydoc, base64ToBytes(opBase64)) }
      catch { /* POC: ignoré — op corrompue */ }
    })

    await this.connection.start()
    return this.connection
  }
}
