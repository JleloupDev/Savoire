// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup

import type { ICollaborativeText, CrdtVersion } from '@savoire/domain-index'

export interface ICRDT {
  onLocalOp(cb: (op: Uint8Array) => void): () => void
  applyRemoteOp(op: Uint8Array): void
  getSnapshot(): Uint8Array

  encodeLocalPresence(changedClients: number[]): Uint8Array
  applyRemotePresence(bytes: Uint8Array): void
  getRemoteCursorPositions(): number[]
  onLocalPresenceChanged(cb: (bytes: Uint8Array, changedClients: number[]) => void): () => void

  onTextChange(cb: (text: ICollaborativeText, version?: CrdtVersion) => void): () => void

  getVersion(): CrdtVersion

  /**
   * Le texte du document avec des positions qui suivent les modifications
   * (ancres de la revision). Absent : pas de texte (document non textuel).
   */
  collaborativeText?(): ICollaborativeText

  /** Le texte du document, modifiable (contrat ISharedText). */
  sharedText?(): import('./sharedText').ISharedText

  dispose(): void
}
