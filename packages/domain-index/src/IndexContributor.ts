// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { ICollaborativeText } from './ICollaborativeText'
import type { AnchorIndex } from './AnchorIndex'

// Pattern A — anchor-based contributor. Receives both markdown ops (for snapshot/seq tracking)
// and live CRDT text changes (for anchor positioning).
export interface IndexContributor {
  readonly namespace: string
  readonly processedSeq: number
  restore(snapshot: string, processedSeq: number): void
  snapshot(): string
  // Called for each markdown op (local or remote). Used by op-log contributors (backlinks, graph).
  onOp(seq: number | null, docId: string, path: string, markdownContent: string): void
  // Called on every CRDT text change. Optional — only anchor-based contributors implement it.
  onTextChange?(text: ICollaborativeText, docId: string, index: AnchorIndex): void
}

