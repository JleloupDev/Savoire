// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup

export interface ITransport {
  join(vaultId: string, docId: string): Promise<void>
  push(op: Uint8Array): Promise<void>
  pushSnapshot(snapshot: Uint8Array): Promise<void>
  pushPresence(bytes: Uint8Array): Promise<void>
  onInit(cb: (ops: Uint8Array[]) => void): () => void
  onRemoteOp(cb: (op: Uint8Array) => void): () => void
  onRemotePresence(cb: (bytes: Uint8Array) => void): () => void
  getState(): 'connected' | 'connecting' | 'disconnected'
  disconnect(): Promise<void>
}
