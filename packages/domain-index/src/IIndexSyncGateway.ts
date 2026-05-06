// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup

// Minimal op payload propagated between peers via the WebSocket dispatcher.
// The server is a pure router — it never interprets this payload.
export interface IndexSyncOp {
  vaultId: string
  docId: string
  // JSON-serialised diff of index entries (add/remove).
  payload: string
}

// Port: channel for broadcasting anchor index operations to other peers.
// Local mode: NoopIndexSyncGateway (no broadcast).
// Cloud mode: SignalRIndexSyncGateway (WebSocket dispatcher via server hub).
// P2P mode: future direct WebRTC adapter.
export interface IIndexSyncGateway {
  broadcast(op: IndexSyncOp): void
  onRemote(handler: (op: IndexSyncOp) => void): () => void
}
