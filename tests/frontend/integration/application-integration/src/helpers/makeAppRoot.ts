// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { AppRoot } from '@savoire/application'
import type { IVaultHubFactory } from '@savoire/application'
import { DocumentStore } from '@savoire/platform'
import {
  HttpAuthBackend,
  HttpAdminBackend,
  HttpSharingBackend,
  HttpVaultsBackend,
  CrdtDocumentFetcher,
  VaultHubClient,
} from '@savoire/infrastructure-sync'

const SERVER_URL = process.env.SERVER_URL ?? 'http://localhost:5000'

// Stub hub — real-time sync not needed for non-document tests (auth, admin, sharing, vaults).
function makeNullHubFactory(): IVaultHubFactory {
  return {
    create: ({ onChanged }) => ({
      connect: async () => { onChanged() },
      dispose: async () => {},
    }),
  }
}

function backends() {
  return {
    authBackend:    new HttpAuthBackend(SERVER_URL),
    adminBackend:   new HttpAdminBackend(SERVER_URL),
    sharingBackend: new HttpSharingBackend(SERVER_URL),
    backend:        new HttpVaultsBackend({ baseUrl: SERVER_URL }),
  }
}

/** Default AppRoot — content read via the CRDT path (SignalR /hubs/sync). */
export function makeAppRoot(getToken: () => string | null, getUserId: () => string = () => 'test-user') {
  const fetcher = new CrdtDocumentFetcher({
    serverUrl: SERVER_URL,
    getToken:  () => getToken(),
    getUserId: () => getUserId(),
  })
  return new AppRoot({
    ...backends(),
    hubFactory:    makeNullHubFactory(),
    documentStore: new DocumentStore(fetcher),
  })
}

/** Alias kept for tests that explicitly want the CRDT read path. */
export const makeCrdtAppRoot = makeAppRoot

/**
 * AppRoot wired with a real VaultHubClient factory.
 * Use for activateVault / disposeActiveVault and hub-driven (CRDT) document ops.
 */
export function makeRealAppRoot(getToken: () => string | null, getUserId: () => string = () => 'test-user') {
  const fetcher = new CrdtDocumentFetcher({
    serverUrl: SERVER_URL,
    getToken:  () => getToken(),
    getUserId: () => getUserId(),
  })

  const hubFactory: IVaultHubFactory = {
    create: ({ vaultId, vaultClient, onChanged }) =>
      new VaultHubClient(SERVER_URL, vaultId, vaultClient, onChanged, getToken),
  }

  return new AppRoot({
    ...backends(),
    hubFactory,
    documentStore: new DocumentStore(fetcher),
  })
}

export { SERVER_URL }
