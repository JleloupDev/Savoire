// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le connecteur local, sans serveur, passe le contrat commun des sessions.
import { InProcessPeerBus, LocalPeerVaultSessionFactory, type YjsCrdtAdapter } from '@savoire/infrastructure-sync'
import { describeVaultSyncSessionContract } from './contract/vaultSyncSessionContract'

const SETTLE_MS = 5

let factory = new LocalPeerVaultSessionFactory(new InProcessPeerBus(), { settleMs: SETTLE_MS })

describeVaultSyncSessionContract('connecteur local', {
  open: (userId) => factory.open({ vaultId: 'v1', token: '', userId, onChanged: () => {} }),
  settle: () => new Promise(r => setTimeout(r, SETTLE_MS * 4)),
  insertText: (crdt, index, text) => {
    const doc = (crdt as YjsCrdtAdapter).rawDoc as { getText(name: string): { insert(i: number, t: string): void } }
    doc.getText('codemirror').insert(index, text)
  },
  reset: () => { factory = new LocalPeerVaultSessionFactory(new InProcessPeerBus(), { settleMs: SETTLE_MS }) },
})
