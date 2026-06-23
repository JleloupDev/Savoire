// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Public surface of the P2P collaboration protocol.

// Core (pure)
export * from './core/envelope'
export * from './core/identity'
export * from './core/keyring'

// Ports
export type { ICrdt } from './ports/crdt'
export type { ITransport, MessageHandler, PeerHandler } from './ports/transport'
export { PeerStore, type KnownPeer, type PeerStatus } from './ports/peer-store'
export type { IStorage } from './ports/storage'

// Adapters
export { YjsCrdt } from './adapters/yjs-crdt'
export { Bus, InProcessTransport } from './adapters/in-process-transport'
export { WebSocketTransport } from './adapters/websocket-transport'
export { InMemoryStorage } from './adapters/in-memory-storage'
export { FileSystemStorage } from './adapters/filesystem-storage'

// Protocol
export * from './protocol/messages'
export { Session, type SessionOpts } from './protocol/session'
export { saveAll, loadIdentity, loadKeyring, loadPeers, loadContent, type PersistableParts } from './protocol/persistence'
