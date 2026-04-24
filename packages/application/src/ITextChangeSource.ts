// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { ICollaborativeText } from '@savoire/domain-index'

// Port: source of live CRDT text changes.
// Implemented by YjsIndexBridge in infrastructure-sync.
// Consumed by RealtimeIndexingService to drive anchor-based contributors.
export interface ITextChangeSource {
  subscribe(handler: (docId: string, text: ICollaborativeText) => void): () => void
}
