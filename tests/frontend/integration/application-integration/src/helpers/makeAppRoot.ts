// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { AppRoot } from '@savoire/application'
import type { IVaultSyncSessionFactory, IVaultSyncSession } from '@savoire/application'
import { DocumentStore } from '@savoire/platform'
import {
  HttpAuthBackend,
  HttpAdminBackend,
  HttpSharingBackend,
  HttpVaultsBackend,
  CrdtDocumentFetcher,
  SavoireServerVaultSession,
  YMapVaultDirectory,
} from '@savoire/infrastructure-sync'

const SERVER_URL = process.env.SERVER_URL ?? 'http://localhost:5000'

// Session stub — la synchro temps reel n'est pas necessaire aux tests hors
// document (auth, admin, sharing, vaults).
function makeNullSessionFactory(): IVaultSyncSessionFactory {
  return {
    open: async ({ onChanged }): Promise<IVaultSyncSession> => {
      const directory = new YMapVaultDirectory()
      onChanged()
      return {
        directory,
        openDocument: () => { throw new Error('null session: no document sync') },
        closeDocument: () => {},
        getState: () => 'disconnected',
        dispose: async () => { directory.dispose() },
      }
    },
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
    vaultSyncSessionFactory: makeNullSessionFactory(),
    documentStore: new DocumentStore(fetcher),
  })
}

/** Alias kept for tests that explicitly want the CRDT read path. */
export const makeCrdtAppRoot = makeAppRoot

/**
 * AppRoot cable sur une vraie session serveur Savoire (VaultHubClient interne).
 * Pour activateVault / disposeActiveVault et les ops document pilotees par le hub.
 */
export function makeRealAppRoot(getToken: () => string | null, getUserId: () => string = () => 'test-user') {
  const fetcher = new CrdtDocumentFetcher({
    serverUrl: SERVER_URL,
    getToken:  () => getToken(),
    getUserId: () => getUserId(),
  })

  const vaultSyncSessionFactory: IVaultSyncSessionFactory = {
    open: (params) => SavoireServerVaultSession.open({
      ...params,
      serverUrl: SERVER_URL,
      getToken,
    }),
  }

  return new AppRoot({
    ...backends(),
    vaultSyncSessionFactory,
    documentStore: new DocumentStore(fetcher),
  })
}

export { SERVER_URL }
