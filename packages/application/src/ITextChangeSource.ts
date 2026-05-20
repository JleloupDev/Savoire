// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { ICollaborativeText } from '@savoire/domain-index'

// Port: source of live CRDT text changes.
// Implemented by an adapter in the composition root (wired to ICRDT.onTextChange).
// Consumed by RealtimeIndexingService to drive anchor-based contributors.
export interface ITextChangeSource {
  subscribe(handler: (docId: string, text: ICollaborativeText) => void): () => void
}
