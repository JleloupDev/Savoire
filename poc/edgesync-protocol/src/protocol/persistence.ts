// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Persistence through the IStorage port. The protocol decides WHAT to persist and
// under WHICH sensitivity namespace; it never decides HOW it is protected at rest
// (the app's adapter does — ADR-0011). Content is stored per channel as
// protocol-ciphertext (reusing that channel's K_doc), so it is never in clear at
// rest even under a plaintext adapter; only `secret/…` (identity, keyring) needs
// the app's at-rest protection.
import { OwnIdentity } from '../core/identity'
import { Keyring } from '../core/keyring'
import { encrypt, decrypt, concat } from '../core/envelope'
import { toHex } from '../core/codec'
import { PeerStore } from '../ports/peer-store'
import type { IStorage } from '../ports/storage'
import type { ICrdt } from '../ports/crdt'

const K_IDENTITY = 'secret/identity'
const K_KEYRING = 'secret/keyring'
const K_PEERS = 'open/peers'
const K_CONTENT = 'open/content'

function contentKey(resourceId: Uint8Array): string {
  return `${K_CONTENT}/${toHex(resourceId)}`
}

export async function loadIdentity(s: IStorage): Promise<OwnIdentity | undefined> {
  const b = await s.get(K_IDENTITY)
  return b ? OwnIdentity.deserialize(b) : undefined
}

export async function loadKeyring(s: IStorage): Promise<Keyring | undefined> {
  const b = await s.get(K_KEYRING)
  return b ? Keyring.deserialize(b) : undefined
}

export async function loadPeers(s: IStorage): Promise<PeerStore | undefined> {
  const b = await s.get(K_PEERS)
  return b ? PeerStore.deserialize(b) : undefined
}

/** Decrypt one channel's persisted (ciphertext) content into the given CRDT. */
export async function loadContent(s: IStorage, resourceId: Uint8Array, crdt: ICrdt, keyring: Keyring): Promise<void> {
  const b = await s.get(contentKey(resourceId))
  if (!b) return
  const epoch = new DataView(b.buffer, b.byteOffset, 4).getUint32(0, false)
  const nonce = b.subarray(4, 28)
  const ciphertext = b.subarray(28)
  const key = keyring.docKey(epoch, resourceId)
  if (!key) return
  try {
    crdt.applyRemote(decrypt(key, nonce, ciphertext))
  } catch {
    // unreadable with the keys we hold
  }
}

export interface PersistableChannel {
  resourceId: Uint8Array
  crdt: ICrdt
}

export interface PersistableParts {
  identity: OwnIdentity
  keyring: Keyring
  peers: PeerStore
  /** One entry per channel to persist (a Session persists only its own). */
  channels: PersistableChannel[]
}

export async function saveAll(s: IStorage, parts: PersistableParts): Promise<void> {
  await s.set(K_IDENTITY, parts.identity.serialize())
  await s.set(K_KEYRING, parts.keyring.serialize())
  await s.set(K_PEERS, parts.peers.serialize())
  // Content at rest = ciphertext under the current epoch's K_doc (never in clear).
  const epoch = parts.keyring.currentEpoch()
  for (const { resourceId, crdt } of parts.channels) {
    const key = parts.keyring.docKey(epoch, resourceId)
    if (!key) continue
    const head = new Uint8Array(4)
    new DataView(head.buffer).setUint32(0, epoch, false)
    const { nonce, ciphertext } = encrypt(key, crdt.snapshot())
    await s.set(contentKey(resourceId), concat(head, nonce, ciphertext))
  }
}
