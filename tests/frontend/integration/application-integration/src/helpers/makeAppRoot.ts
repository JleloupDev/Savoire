// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { AppRoot } from '@savoire/application'
import type { IVaultHubFactory } from '@savoire/application'
import { DocumentStore } from '@savoire/platform'
import type { VaultClient } from '@savoire/platform'
import {
  HttpAuthBackend,
  HttpAdminBackend,
  HttpSharingBackend,
  HttpVaultsBackend,
  RestDocumentFetcher,
  CrdtDocumentFetcher,
  VaultHubClient,
} from '@savoire/infrastructure-sync'

const SERVER_URL = process.env.SERVER_URL ?? 'http://localhost:5000'

// Stub hub — structural operations routed via REST, real-time sync not needed for these tests.
function makeNullHubFactory(): IVaultHubFactory {
  return {
    create: ({ onChanged }) => ({
      connect: async () => { onChanged() },
      dispose: async () => {},
      createDocument: async (path: string) => {
        throw new Error(`createDocument("${path}") requires a real hub — use REST instead`)
      },
      renameDocument: async () => {},
      deleteDocument: async () => {},
    }),
  }
}

export function makeAppRoot(getToken: () => string | null) {
  const fetcher = new RestDocumentFetcher({ baseUrl: SERVER_URL })
  const documentStore = new DocumentStore(fetcher)

  return new AppRoot({
    authBackend:    new HttpAuthBackend(SERVER_URL),
    adminBackend:   new HttpAdminBackend(SERVER_URL),
    sharingBackend: new HttpSharingBackend(SERVER_URL),
    backend:        new HttpVaultsBackend({ baseUrl: SERVER_URL }),
    hubFactory:     makeNullHubFactory(),
    documentStore,
  })
}

/**
 * AppRoot variant that reads document content via the CRDT path (SignalR /hubs/sync).
 * Use this to verify that content written by one client is visible to another via
 * the real collaboration channel.
 */
export function makeCrdtAppRoot(getToken: () => string | null, getUserId: () => string) {
  const fetcher = new CrdtDocumentFetcher({
    serverUrl: SERVER_URL,
    getToken:  () => getToken(),
    getUserId: () => getUserId(),
  })
  const documentStore = new DocumentStore(fetcher)

  return new AppRoot({
    authBackend:    new HttpAuthBackend(SERVER_URL),
    adminBackend:   new HttpAdminBackend(SERVER_URL),
    sharingBackend: new HttpSharingBackend(SERVER_URL),
    backend:        new HttpVaultsBackend({ baseUrl: SERVER_URL }),
    hubFactory:     makeNullHubFactory(),
    documentStore,
  })
}

/**
 * AppRoot variant wired with a real VaultHubClient factory.
 * Use this when you need to test activateVault / disposeActiveVault
 * and hub-driven document operations through the application layer.
 */
export function makeRealAppRoot(getToken: () => string | null) {
  const fetcher = new RestDocumentFetcher({ baseUrl: SERVER_URL })
  const documentStore = new DocumentStore(fetcher)

  const hubFactory: IVaultHubFactory = {
    create: ({ vaultId, vaultClient, onChanged }) =>
      new VaultHubClient(SERVER_URL, vaultId, vaultClient, onChanged, getToken),
  }

  return new AppRoot({
    authBackend:    new HttpAuthBackend(SERVER_URL),
    adminBackend:   new HttpAdminBackend(SERVER_URL),
    sharingBackend: new HttpSharingBackend(SERVER_URL),
    backend:        new HttpVaultsBackend({ baseUrl: SERVER_URL }),
    hubFactory,
    documentStore,
  })
}

export { SERVER_URL }
