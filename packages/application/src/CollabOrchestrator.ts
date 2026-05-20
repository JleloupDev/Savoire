// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup

import type { ICRDT, ITransport } from '@savoire/plugin-api'

const COMPACT_THRESHOLD = 100

export class CollabOrchestrator {
  private readonly cleanups: Array<() => void> = []

  constructor(crdt: ICRDT, transport: ITransport) {
    this.cleanups.push(
      crdt.onLocalOp((op) => void transport.push(op)),
      crdt.onLocalPresenceChanged((bytes) => void transport.pushPresence(bytes)),
      transport.onInit((ops) => {
        ops.forEach((op) => crdt.applyRemoteOp(op))
        if (ops.length > COMPACT_THRESHOLD) {
          void transport.pushSnapshot(crdt.getSnapshot())
        }
      }),
      transport.onRemoteOp((op) => crdt.applyRemoteOp(op)),
      transport.onRemotePresence((bytes) => crdt.applyRemotePresence(bytes)),
    )
  }

  dispose(): void {
    this.cleanups.forEach((fn) => fn())
  }
}
