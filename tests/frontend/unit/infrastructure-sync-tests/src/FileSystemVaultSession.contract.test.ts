// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// La session sur disque passe le contrat commun des sessions. Les « pairs »
// du contrat sont deux sessions ouvertes sur le MEME dossier (deux fenetres) :
// elles se voient par la surveillance du disque (watch), sans reseau.
//
// Deux disques : en memoire, et un vrai dossier temporaire (node:fs).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'
import { InMemoryVaultFileSystem, type IVaultFileSystem } from '@savoire/platform'
import { FileSystemVaultSessionFactory, type YjsCrdtAdapter } from '@savoire/infrastructure-sync'
import type { ICRDT } from '@savoire/plugin-api'
import { describeVaultSyncSessionContract } from './contract/vaultSyncSessionContract'
import { NodeVaultFileSystem } from './support/NodeVaultFileSystem'

const OPTIONS = { persistMs: 1, projectMs: 2, scanMs: 2 }

const insertText = (crdt: ICRDT, index: number, text: string): void => {
  const doc = (crdt as YjsCrdtAdapter).rawDoc as { getText(name: string): { insert(i: number, t: string): void } }
  doc.getText('codemirror').insert(index, text)
}

let memoryFs: IVaultFileSystem = new InMemoryVaultFileSystem()

describeVaultSyncSessionContract('vault sur disque (memoire)', {
  open: userId => new FileSystemVaultSessionFactory(() => memoryFs, OPTIONS)
    .open({ vaultId: 'v1', token: '', userId, onChanged: () => {} }),
  settle: () => new Promise(r => setTimeout(r, 40)),
  insertText,
  reset: () => { memoryFs = new InMemoryVaultFileSystem() },
})

const tempDirs: string[] = []
const newTempVault = (): NodeVaultFileSystem => {
  const dir = mkdtempSync(join(tmpdir(), 'savoire-vault-'))
  tempDirs.push(dir)
  return new NodeVaultFileSystem(dir)
}
let nodeFs = newTempVault()

describeVaultSyncSessionContract('vault sur disque (dossier reel)', {
  open: userId => new FileSystemVaultSessionFactory(() => nodeFs, OPTIONS)
    .open({ vaultId: 'v1', token: '', userId, onChanged: () => {} }),
  // fs.watch livre ses evenements avec un peu de retard : on laisse plus de marge.
  settle: () => new Promise(r => setTimeout(r, 150)),
  insertText,
  reset: () => { nodeFs = newTempVault() },
})

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})
