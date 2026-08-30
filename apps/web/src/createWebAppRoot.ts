// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import {
  AppRoot, AuthService, AdminService, SharingService,
  type IVaultsBackend, type IVaultSyncSessionFactory,
} from '@savoire/application'
import {
  CrdtDocumentFetcher, DocumentRoomClient,
  HttpAdminBackend, HttpAuthBackend, HttpSharingBackend, HttpVaultsBackend,
  RestVaultStorage, ServerKeyProvider, SavoireServerVaultSession,
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
  // DERNIERE inversion restante : ce fetcher sert le contenu ponctuel
  // (embeds ![[...]], vault.read()) et parle a SyncHub, donc au serveur
  // Savoire uniquement. Un protocole qui possede le stockage des documents
  // (blobs EdgeSync, Repo automerge) doit fournir le sien : IDocumentFetcher
  // devrait venir de la session, comme le repertoire et les CRDT. En l'etat,
  // les embeds sont vides en profil EdgeSync. Voir IVaultSyncSession.
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
  /** Absente = profil serveur Savoire (defaut). Fournie (voir
   *  edgesyncProfile.ts) = profil EdgeSync : P2P, E2E, serveur aveugle.
   *  Demain, un connecteur automerge-repo se brancherait au meme endroit. */
  vaultSyncSessionFactory?: IVaultSyncSessionFactory
  onConnectionChange?: (state: 'connected' | 'disconnected') => void
}

/** Profil par defaut : serveur Savoire. Le hub relaie le repertoire et les
 *  documents, le serveur lit les donnees. Voir edgesyncProfile.ts pour le
 *  profil P2P, et IVaultSyncSession pour le contrat commun. */
function makeServerVaultSessionFactory(
  getToken: () => string | null,
  onConnectionChange?: (state: 'connected' | 'disconnected') => void,
): IVaultSyncSessionFactory {
  return {
    open: (params) => SavoireServerVaultSession.open({
      ...params,
      getToken,
      serverUrl: '',
      onConnectionChange: params.onConnectionChange ?? onConnectionChange,
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
    vaultSyncSessionFactory:
      params.vaultSyncSessionFactory
      ?? makeServerVaultSessionFactory(params.getToken, params.onConnectionChange),
    documentStore: params.documentStore,
    identityProvider,
  })
}
