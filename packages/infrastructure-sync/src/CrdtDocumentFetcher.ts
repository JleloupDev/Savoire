// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup

import { serverUrl as resolveServerUrl } from './serverAddress'
import * as Y from 'yjs'
import {
  HubConnection,
  HubConnectionBuilder,
  HubConnectionState,
} from '@microsoft/signalr'
import type { IDocumentFetcher } from '@savoire/platform'
import { base64ToBytes } from './base64'

// Meme contournement que YjsCrdtAdapter : les API avancees de Yjs ne sont pas
// vues par le typage (chaine de re-export .js -> .d.ts).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Y_ = Y as Record<string, any>

function defaultConnectionFactory(
  serverUrl: string,
  getToken: () => string | null,
  userId: string,
): HubConnection {
  return new HubConnectionBuilder()
    .withUrl(resolveServerUrl(`/hubs/sync?userId=${encodeURIComponent(userId)}`, serverUrl), {
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

export interface DocEventCallbacks {
  onRenamed?: (newPath: string) => void
  onDeleted?: () => void
  onAccessRevoked?: (targetUserId: string) => void
}

export class CrdtDocumentFetcher implements IDocumentFetcher {
  private readonly serverUrl: string
  private readonly getToken: () => string | null
  private readonly getUserId: () => string
  private readonly connectionFactory: (serverUrl: string, getToken: () => string | null, userId: string) => HubConnection
  private connection: HubConnection | null = null
  private starting: Promise<HubConnection> | null = null
  private readonly docs = new Map<string, DocEntry>()
  private readonly docEventCallbacks = new Map<string, DocEventCallbacks>()

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

  /**
   * Etat complet encode d'un document, tel que le serveur le garde. Sans
   * cache : le document est quitte apres la lecture (copie d'un vault entier),
   * sauf s'il etait deja suivi pour une lecture de texte.
   */
  async getDocumentState(vaultId: string, docId: string): Promise<Uint8Array> {
    const existing = this.docs.get(docId)
    if (existing) {
      if (!existing.ready) await existing.initPromise
      return Y_.encodeStateAsUpdate(existing.ydoc) as Uint8Array
    }
    try {
      await this.getDocumentContent(vaultId, docId, '')
    } catch (err) {
      // Refus du serveur : ne pas laisser une entree qui attendrait toujours.
      this.docs.delete(docId)
      throw err
    }
    const entry = this.docs.get(docId)
    const state: Uint8Array = entry ? Y_.encodeStateAsUpdate(entry.ydoc) : new Uint8Array()
    this.docs.delete(docId)
    if (entry) Y_.Doc.prototype.destroy.call(entry.ydoc)
    const conn = this.connection
    if (conn && conn.state === HubConnectionState.Connected) {
      await conn.invoke('LeaveDocument', vaultId, docId).catch(() => { /* best effort */ })
    }
    return state
  }

  /**
   * Pousse une op (deja signee) dans un document. Rejette si le serveur la
   * refuse ou si la connexion manque : pas de perte silencieuse.
   */
  async pushOperation(vaultId: string, docId: string, clientId: string, opBase64: string): Promise<void> {
    const conn = await this.ensureConnection()
    await conn.invoke('PushOperation', vaultId, docId, clientId, opBase64)
  }

  async writeDocumentContent(_vaultId: string, _docId: string, _content: string, _token: string): Promise<void> {
    // CRDT documents are written via Yjs ops, not REST. This method is intentionally a no-op.
  }

  /**
   * Subscribe to document metadata events (rename, delete, access revoke) for
   * a specific document. These arrive via the SyncHub doc-events group, which
   * the server adds the caller to when JoinDocument detects a non-vault-member.
   * Returns an unsubscribe function.
   */
  subscribeDocumentEvents(docId: string, callbacks: DocEventCallbacks): () => void {
    this.docEventCallbacks.set(docId, callbacks)
    return () => { this.docEventCallbacks.delete(docId) }
  }

  /** Ferme la connexion et libere les documents. Une lecture en attente rend un texte vide. */
  async dispose(): Promise<void> {
    const conn = this.connection
    this.connection = null
    for (const entry of this.docs.values()) entry.resolveInit()
    this.docs.clear()
    this.docEventCallbacks.clear()
    if (conn) await conn.stop().catch(() => {})
  }

  /**
   * La connexion, demarree une seule fois meme si plusieurs lectures la
   * demandent en meme temps (copie d'un vault) : sans cela, les suivantes
   * l'utiliseraient avant la fin de son demarrage.
   */
  private ensureConnection(): Promise<HubConnection> {
    if (this.connection?.state === HubConnectionState.Connected) return Promise.resolve(this.connection)
    this.starting ??= this.connect().finally(() => { this.starting = null })
    return this.starting
  }

  private async connect(): Promise<HubConnection> {
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

    this.connection.on('DocumentRenamed', (docId: string, newPath: string) => {
      this.docEventCallbacks.get(docId)?.onRenamed?.(newPath)
    })

    this.connection.on('DocumentDeleted', (docId: string) => {
      this.docEventCallbacks.get(docId)?.onDeleted?.()
    })

    this.connection.on('AccessRevoked', (docId: string, targetUserId: string) => {
      this.docEventCallbacks.get(docId)?.onAccessRevoked?.(targetUserId)
    })

    await this.connection.start()
    return this.connection
  }
}
