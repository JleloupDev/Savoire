// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { DocumentStore, VaultClient } from '@savoire/platform'
import type { IDocumentMeta } from '@savoire/platform'
import { CrdtDocumentFetcher, RestVaultStorage, VaultHubClient, YMapVaultDirectory } from '@savoire/infrastructure-sync'
import { SERVER_URL } from './makeAppRoot'

/**
 * Opens a real SignalR vault hub backed by a CRDT directory.
 * Document mutations go through the vault CRDT (createFile/renameFile/deleteFile),
 * which the hub pushes to the server and relays to peers.
 * Always call dispose() when done.
 */
export async function makeVaultHub(vaultId: string, getToken: () => string, userId = 'test-user') {
  const storage = new RestVaultStorage({ baseUrl: SERVER_URL })
  const fetcher = new CrdtDocumentFetcher({ serverUrl: SERVER_URL, getToken, getUserId: () => userId })
  const documentStore = new DocumentStore(fetcher)
  const directory = new YMapVaultDirectory()
  const vaultClient = new VaultClient(vaultId, getToken(), storage, documentStore, directory, () => undefined)
  const hub = new VaultHubClient(SERVER_URL, vaultId, vaultClient, () => {}, getToken)
  await hub.connect()

  const norm = (p: string) => p.includes('.') ? p : `${p}.md`
  // Vault ops are pushed fire-and-forget (onLocalVaultUpdate -> pushVaultUpdate).
  // Settle briefly so the SignalR invoke completes before the caller disposes.
  const settle = () => new Promise(r => setTimeout(r, 150))

  return {
    hub,
    vaultClient,
    directory,

    /** Create a document via the CRDT directory; returns its meta. */
    async createDocument(path: string): Promise<IDocumentMeta> {
      await vaultClient.createFile(path)
      const meta = vaultClient.documents.find(d => d.path === norm(path))
      if (!meta) throw new Error(`createDocument: ${path} not found after createFile`)
      await settle()
      return meta
    },

    async renameDocument(id: string, newPath: string): Promise<void> {
      await vaultClient.renameFile(id, newPath)
      await settle()
    },

    async deleteDocument(id: string): Promise<void> {
      await vaultClient.deleteFile(id)
      await settle()
    },

    documents(): readonly IDocumentMeta[] {
      return vaultClient.documents
    },

    /** Poll the directory until the predicate holds or the timeout elapses. */
    async waitFor(predicate: (docs: readonly IDocumentMeta[]) => boolean, timeoutMs = 3000): Promise<boolean> {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (predicate(vaultClient.documents)) return true
        await new Promise(r => setTimeout(r, 25))
      }
      return predicate(vaultClient.documents)
    },

    dispose: async () => { await hub.dispose(); directory.dispose() },
  }
}
