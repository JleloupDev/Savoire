// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { IIndexSyncGateway, IndexSyncOp } from '@savoire/domain-index'

// No-op implementation for local / offline mode.
// The index is built and queried locally — no broadcast, no remote ops.
export class NoopIndexSyncGateway implements IIndexSyncGateway {
  broadcast(_op: IndexSyncOp): void { /* no-op */ }
  onRemote(_handler: (op: IndexSyncOp) => void): () => void { return () => { /* no-op */ } }
}
