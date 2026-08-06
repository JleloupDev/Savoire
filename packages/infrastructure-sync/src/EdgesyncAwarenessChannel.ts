// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Peer cursor / presence (y-protocols/awareness) over the same edgesync
// transport and K_doc as a document's content — a deliberately separate,
// much simpler path than Session: awareness is ephemeral (ok to lose),
// high-frequency (every cursor move), and needs no history/catch-up for a
// late joiner (a peer who opens the document later just sees no stale
// cursors until the next live update — exactly how awareness already
// behaves in plain Yjs setups). So no HELLO handshake, no SyncReq/SyncResp,
// no signature/PeerStore pinning: just AEAD-encrypt with the document's
// already-granted K_doc (tamper-evident; possession of K_doc is itself the
// authentication, same trust level as decrypting an Op) and broadcast.
//
// Disambiguated from Session's own frames (MsgType 1-5) and
// EdgesyncWebRtcTransport's WebRTC signaling (SIGNAL_TAG 0xF0) by a third
// reserved tag byte on the same shared transport — same trick, third tag.
import { Keyring, encrypt, decrypt, resourceId as toResourceId } from 'edgesync-protocol'
import type { ITransport } from 'edgesync-protocol'

/** Exported so callers (e.g. EdgesyncVaultSession's diagnostic frame logger) can label awareness frames distinctly. */
export const AWARENESS_TAG = 0xA0
const RID_LEN = 32
const NONCE_LEN = 24
const HEADER_LEN = 1 + RID_LEN + NONCE_LEN

export interface EdgesyncAwarenessChannelOptions {
  /** Same resource string as the document's Session (e.g. `${vaultId}/${docId}`) — reuses its K_doc, no separate key. */
  resource: string
  keyring: Keyring
  transport: ITransport
}

export class EdgesyncAwarenessChannel {
  private readonly resourceId: Uint8Array
  private readonly keyring: Keyring
  private readonly transport: ITransport
  private handlers: ((bytes: Uint8Array) => void)[] = []
  private readonly unsubscribe: () => void

  constructor(o: EdgesyncAwarenessChannelOptions) {
    this.resourceId = toResourceId(o.resource)
    this.keyring = o.keyring
    this.transport = o.transport
    this.unsubscribe = o.transport.onMessage((_from, bytes) => this.onMessage(bytes))
  }

  /** Encrypt and broadcast an awareness update (e.g. y-protocols/awareness's
   *  encodeAwarenessUpdate output) to every currently-connected peer. */
  broadcast(plaintext: Uint8Array): void {
    const epoch = this.keyring.currentEpoch()
    const key = this.keyring.docKey(epoch, this.resourceId)
    if (!key) return // not keyed yet on this channel; nothing to encrypt with
    const { nonce, ciphertext } = encrypt(key, plaintext)
    const frame = new Uint8Array(HEADER_LEN + ciphertext.length)
    frame[0] = AWARENESS_TAG
    frame.set(this.resourceId, 1)
    frame.set(nonce, 1 + RID_LEN)
    frame.set(ciphertext, HEADER_LEN)
    for (const peer of this.transport.peers()) this.transport.send(peer, frame)
  }

  /** Fires with the decrypted plaintext (feed straight to y-protocols/awareness's applyAwarenessUpdate). */
  onUpdate(cb: (plaintext: Uint8Array) => void): () => void {
    this.handlers.push(cb)
    return () => { this.handlers = this.handlers.filter((h) => h !== cb) }
  }

  private onMessage(bytes: Uint8Array): void {
    if (bytes.length < HEADER_LEN || bytes[0] !== AWARENESS_TAG) return
    if (!eqBytes(bytes.subarray(1, 1 + RID_LEN), this.resourceId)) return
    const epoch = this.keyring.currentEpoch()
    const key = this.keyring.docKey(epoch, this.resourceId)
    if (!key) return
    const nonce = bytes.subarray(1 + RID_LEN, HEADER_LEN)
    const ciphertext = bytes.subarray(HEADER_LEN)
    let plaintext: Uint8Array
    try {
      plaintext = decrypt(key, nonce, ciphertext)
    } catch {
      return // tampered or wrong key: silent drop, consistent with Session's philosophy
    }
    for (const h of this.handlers) h(plaintext)
  }

  dispose(): void {
    this.unsubscribe()
    this.handlers = []
  }
}

function eqBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}
