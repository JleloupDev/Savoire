// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { IndexEngine } from '@savoire/domain-index'
import type { ITextChangeSource } from './ITextChangeSource'
import type { IIndexSyncGateway } from '@savoire/domain-index'

// Drives anchor-based index contributors on every live CRDT text change.
// Distinct from ContentIndexingService which handles op-log contributors (backlinks, graph).
//
// Lifecycle:
//   1. Construct with the three dependencies.
//   2. Call start() once the vault is active — subscribes to live changes.
//   3. Call stop() on vault deactivation.
export class RealtimeIndexingService {
  private unsubscribeText: (() => void) | null = null
  private unsubscribeRemote: (() => void) | null = null

  constructor(
    private readonly source: ITextChangeSource,
    private readonly engine: IndexEngine,
    private readonly gateway: IIndexSyncGateway,
  ) {}

  start(): void {
    this.unsubscribeText = this.source.subscribe((docId, text) => {
      this.engine.onTextChange(text, docId)
      // Future: serialize diff and broadcast via gateway.
      // Currently not broadcasting — index convergence via re-computation on sync.
    })

    this.unsubscribeRemote = this.gateway.onRemote((_op) => {
      // DECISION: checkStaleness / revalidationQueue are not yet wired.
      // When a remote op arrives the correct behaviour is: call engine.checkStaleness(docId, ts),
      // then drain revalidationQueue by fetching the doc content and calling engine.onTextChange.
      // Not implemented — placeholder kept so the gateway subscription compiles.
    })
  }

  stop(): void {
    this.unsubscribeText?.()
    this.unsubscribeRemote?.()
    this.unsubscribeText = null
    this.unsubscribeRemote = null
  }
}
