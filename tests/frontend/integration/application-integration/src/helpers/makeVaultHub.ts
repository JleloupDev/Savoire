// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { DocumentStore, VaultClient } from '@savoire/platform'
import { RestDocumentFetcher, RestVaultStorage, RestContentStore, VaultHubClient } from '@savoire/infrastructure-sync'
import { SERVER_URL } from './makeAppRoot'

/**
 * Opens a real SignalR hub connection for a vault.
 * Useful for document creation and other hub-required operations in tests.
 * Always call dispose() when done.
 */
export async function makeVaultHub(vaultId: string, getToken: () => string) {
  const storage = new RestVaultStorage({ baseUrl: SERVER_URL })
  const fetcher = new RestDocumentFetcher({ baseUrl: SERVER_URL })
  const documentStore = new DocumentStore(fetcher)
  const vaultClient = new VaultClient(vaultId, getToken(), storage, documentStore, () => undefined)
  const hub = new VaultHubClient(SERVER_URL, vaultId, vaultClient, () => {}, getToken)
  await hub.connect()
  return {
    hub,
    vaultClient,
    content: new RestContentStore({ baseUrl: SERVER_URL, getToken }),
    dispose: () => hub.dispose(),
  }
}
