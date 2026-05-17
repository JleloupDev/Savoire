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
} from '@savoire/infrastructure-sync'

const SERVER_URL = process.env.SERVER_URL ?? 'http://localhost:5000'

// Stub hub — structural operations routed via REST, real-time sync not needed for these tests.
function makeNullHubFactory(getToken: () => string | null): IVaultHubFactory {
  return {
    create: ({ vaultClient, onChanged }) => ({
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
    hubFactory:     makeNullHubFactory(getToken),
    documentStore,
  })
}

export { SERVER_URL }
