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
  EdgesyncVaultSession, RemoteEdgesyncBlobStorage, VaultKeyEscrow, ManagedVaultKeyringSource, type YMapVaultDirectory,
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
  /** K_User for the currently active account, or null if not entered yet
   *  (VaultKeyContext) — see VaultKeyEscrow.ts. */
  getVaultKey: () => Uint8Array | null
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

function makeEdgesyncVaultSessionFactory(
  getToken: () => string | null,
  getVaultKey: () => Uint8Array | null,
): IEdgesyncVaultSessionFactory {
  return {
    // storage (content, RemoteEdgesyncBlobStorage) is always S3 — the server
    // only ever sees ciphertext for it, regardless of the vault's key mode.
    // keyEscrow picks S2 (ManagedVaultKeyringSource, server holds the
    // Keyring in clear, no K_User) or S3 (VaultKeyEscrow, wrapped under
    // K_User) per-vault, per Vault.IsManaged — decided once at creation, see
    // AppVaultSummary.isManaged. One instance per open() call (cheap — no
    // connection of their own, just a fetch() closure) so each is scoped to
    // that vaultId.
    open: ({ vaultId, identitySeed, directory, isManaged }) =>
      EdgesyncVaultSession.open({
        vaultId,
        identitySeed,
        // The app always constructs a real YMapVaultDirectory for `directory`
        // (AppShell.tsx); IVaultDirectory itself stays edgesync-agnostic to
        // avoid a dependency cycle (infrastructure-sync already depends on
        // @savoire/application).
        directory: directory as YMapVaultDirectory,
        serverUrl: '',
        getToken,
        storage: new RemoteEdgesyncBlobStorage({ vaultId, getToken }),
        keyEscrow: isManaged
          ? new ManagedVaultKeyringSource({ getToken })
          : new VaultKeyEscrow({ getToken, getVaultKey }),
      }),
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
    edgesyncVaultSessionFactory: makeEdgesyncVaultSessionFactory(params.getToken, params.getVaultKey),
    documentStore: params.documentStore,
    identityProvider,
  })
}
