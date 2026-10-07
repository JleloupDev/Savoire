// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// DocumentRoomClient: SyncAPI implementation over SignalR /hubs/room.
//
// Uses a separate hub from the CRDT hub (/hubs/sync): last-write-wins on full JSON
// snapshots, suited for non-textual documents (Excalidraw, diagrams, tables).

import {
  HubConnection,
  HubConnectionBuilder,
  HubConnectionState,
  LogLevel,
} from '@microsoft/signalr'
import type { DocumentRoom, DocumentRoomPresence, SyncAPI } from '@savoire/plugin-api'

/** Room rejointe : expose en plus le snapshot que le serveur renvoie a l'entree. */
export interface JoinedDocumentRoom extends DocumentRoom {
  /** Dernier snapshot persiste, ou null si le document n'a jamais ete ecrit. */
  readonly initialSnapshot: Promise<string | null>
}

// ── DocumentRoomHandle ─────────────────────────────────────────────────────
// Represents a single room subscription on a shared HubConnection.

class DocumentRoomHandle implements JoinedDocumentRoom {
  private readonly snapshotListeners = new Set<(json: string, userId: string) => void>()
  private readonly presenceListeners = new Set<(userId: string, p: DocumentRoomPresence) => void>()
  private closed = false
  private resolveInitial!: (snapshot: string | null) => void
  readonly initialSnapshot = new Promise<string | null>(r => { this.resolveInitial = r })

  constructor(
    private readonly conn: HubConnection,
    private readonly vaultId: string,
    private readonly docId: string,
    _userId: string,
    /** Called by DocumentRoomClient when close() is invoked. */
    private readonly onClose: (docId: string, handle: DocumentRoomHandle) => void,
  ) {}

  // Called by DocumentRoomClient on RoomJoined. Only the first call counts.
  _dispatchJoined(snapshot: string | null): void {
    this.resolveInitial(snapshot)
  }

  // Called by DocumentRoomClient when a SnapshotReceived event arrives for this room.
  _dispatchSnapshot(fromUserId: string, snapshotJson: string): void {
    for (const cb of this.snapshotListeners) cb(snapshotJson, fromUserId)
  }

  // Called by DocumentRoomClient when a PresenceUpdated event arrives for this room.
  _dispatchPresence(userId: string, presence: DocumentRoomPresence): void {
    for (const cb of this.presenceListeners) cb(userId, presence)
  }

  async pushSnapshot(snapshotJson: string): Promise<void> {
    if (this.closed) return
    if (this.conn.state !== HubConnectionState.Connected) return
    await this.conn.invoke('PushSnapshot', this.vaultId, this.docId, snapshotJson)
  }

  async updatePresence(presence: DocumentRoomPresence): Promise<void> {
    if (this.closed || this.conn.state !== HubConnectionState.Connected) return
    const json = JSON.stringify(presence)
    await this.conn.invoke('UpdatePresence', this.vaultId, this.docId, json)
  }

  onSnapshot(cb: (snapshotJson: string, fromUserId: string) => void): () => void {
    this.snapshotListeners.add(cb)
    return () => this.snapshotListeners.delete(cb)
  }

  onPresence(cb: (userId: string, presence: DocumentRoomPresence) => void): () => void {
    this.presenceListeners.add(cb)
    return () => this.presenceListeners.delete(cb)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.snapshotListeners.clear()
    this.presenceListeners.clear()
    this.resolveInitial(null)
    // Se retirer AVANT d'attendre le serveur : un openRoom() lance juste apres
    // doit creer une nouvelle poignee, pas recuperer celle-ci, deja morte.
    this.onClose(this.docId, this)
    try {
      await this.conn.invoke('LeaveRoom', this.vaultId, this.docId)
    } catch {
      // Best-effort leave.
    }
  }
}

// ── DocumentRoomClient ─────────────────────────────────────────────────────

export interface DocumentRoomClientOptions {
  serverUrl?: string
  getToken?: () => string | null | undefined
}

export class DocumentRoomClient implements SyncAPI {
  private readonly serverUrl: string
  private readonly getToken: () => string | null | undefined
  private connection: HubConnection | null = null
  private connectedUserId: string | null = null
  private readonly rooms = new Map<string, DocumentRoomHandle>()
  private startPromise: Promise<void> | null = null

  constructor(options: DocumentRoomClientOptions = {}) {
    this.serverUrl = options.serverUrl ?? ''
    this.getToken = options.getToken ?? (() => null)
  }

  async openRoom(vaultId: string, docId: string, userId: string): Promise<JoinedDocumentRoom> {
    const conn = this.ensureConnection(userId)
    if (conn.state === HubConnectionState.Disconnected) {
      // Start and store the promise so concurrent callers can await it.
      this.startPromise = conn.start().finally(() => { this.startPromise = null })
    }
    // If a connection is in progress (Connecting), wait for it to complete.
    if (this.startPromise) {
      await this.startPromise
    }

    const existing = this.rooms.get(docId)
    if (existing) return existing

    const handle = new DocumentRoomHandle(conn, vaultId, docId, userId, (id, closing) => {
      if (this.rooms.get(id) === closing) this.rooms.delete(id)
    })
    this.rooms.set(docId, handle)

    await conn.invoke('JoinRoom', vaultId, docId)
    // Le serveur envoie RoomJoined AVANT de terminer JoinRoom. S'il ne l'a pas
    // fait (serveur ancien), le document est considere comme jamais ecrit.
    handle._dispatchJoined(null)

    return handle
  }

  private ensureConnection(userId: string): HubConnection {
    if (this.connection && this.connectedUserId === userId) return this.connection
    if (this.connection) {
      // Reinit if userId changed (e.g. account switch).
      void this.connection.stop()
      this.connection = null
    }

    this.connectedUserId = userId
    this.connection = new HubConnectionBuilder()
      .withUrl(`${this.serverUrl}/hubs/room?userId=${encodeURIComponent(userId)}`, {
        accessTokenFactory: () => this.getToken() ?? '',
      })
      .configureLogging(LogLevel.None)
      .withAutomaticReconnect()
      .build()

    // Route incoming messages to the correct DocumentRoomHandle.
    this.connection.on('SnapshotReceived', (docId: string, fromUserId: string, snapshotJson: string) => {
      this.rooms.get(docId)?._dispatchSnapshot(fromUserId, snapshotJson)
    })

    this.connection.on('PresenceUpdated', (docId: string, userId: string, presenceJson: string) => {
      let presence: DocumentRoomPresence
      try {
        presence = JSON.parse(presenceJson) as DocumentRoomPresence
      } catch {
        presence = { userId }
      }
      this.rooms.get(docId)?._dispatchPresence(userId, presence)
    })

    // RoomJoined porte le dernier snapshot persiste : c'est l'etat initial du
    // document. L'ancien chemin le relisait par REST, qui ne le servait plus.
    this.connection.on('RoomJoined', (docId: string, snapshot: string | null) => {
      this.rooms.get(docId)?._dispatchJoined(snapshot ?? null)
    })

    return this.connection
  }
}
