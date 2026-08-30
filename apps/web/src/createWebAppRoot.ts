// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import {
  AppRoot, AuthService, AdminService, SharingService,
  type IVaultHubFactory, type IVaultsBackend, type IEdgesyncVaultSessionFactory,
} from '@savoire/application'
import {
  CrdtDocumentFetcher, DocumentRoomClient,
  HttpAdminBackend, HttpAuthBackend, HttpSharingBackend, HttpVaultsBackend,
  RestVaultStorage, ServerKeyProvider, VaultHubClient,
} from '@savoire/infrastructure-sync'
import { DocumentStore } from '@savoire/platform'

// ── Backends (singletons partagés entre services) ─────────────────────────────

const adminBackend  = new HttpAdminBackend()
const authBackend   = new HttpAuthBackend()
const sharingBackend = new HttpSharingBackend()
const backend: IVaultsBackend = new HttpVaultsBackend()

// ── Services factory (pour App.tsx) ───────────────────────────────────────────

export function createWebServices() {
  return {
    authApi:    new AuthService(authBackend),
    adminApi:   new AdminService(adminBackend),
    sharingApi: new SharingService(sharingBackend),
  }
}

// ── Infrastructure singletons factory (pour AppShell) ────────────────────────

export function createWebInfrastructure(
  getToken:   () => string | null,
  getUserId:  () => string,
) {
  const documentFetcher = new CrdtDocumentFetcher({ getToken, getUserId })
  const vaultStorage    = new RestVaultStorage()
  const documentStore   = new DocumentStore(documentFetcher)
  const roomClient      = new DocumentRoomClient({ getToken })
  return { documentFetcher, vaultStorage, roomClient, documentStore }
}

// ── AppRoot factory ───────────────────────────────────────────────────────────

export interface CreateWebAppRootParams {
  documentStore: DocumentStore
  getToken: () => string | null
  /** K_User du compte actif, ou null. Utile au seul profil EdgeSync
   *  (VaultKeyContext) — ignoré en profil serveur. */
  getVaultKey: () => Uint8Array | null
  /** Absent = profil serveur Savoire (défaut) : le hub relaie le répertoire et
   *  les documents, le serveur lit les données. Fourni (voir edgesyncProfile.ts)
   *  = profil EdgeSync : P2P, E2E, serveur aveugle. */
  edgesyncVaultSessionFactory?: IEdgesyncVaultSessionFactory
  onConnectionChange?: (state: 'connected' | 'disconnected') => void
}

function makeHubFactory(
  getToken: () => string | null,
  onConnectionChange?: (state: 'connected' | 'disconnected') => void,
): IVaultHubFactory {
  return {
    create: ({ vaultId, vaultClient, onChanged }) =>
      new VaultHubClient('', vaultId, vaultClient, onChanged, getToken, onConnectionChange),
  }
}

export function createWebAppRoot(params: CreateWebAppRootParams): AppRoot {
  const identityProvider = new ServerKeyProvider({ getToken: params.getToken })
  return new AppRoot({
    adminBackend,
    authBackend,
    sharingBackend,
    backend,
    hubFactory: makeHubFactory(params.getToken, params.onConnectionChange),
    edgesyncVaultSessionFactory: params.edgesyncVaultSessionFactory,
    documentStore: params.documentStore,
    identityProvider,
  })
}
