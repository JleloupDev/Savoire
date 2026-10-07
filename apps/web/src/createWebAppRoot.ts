// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import {
  AppRoot, AuthService, AdminService, SharingService,
  type IVaultsBackend, type IVaultSyncSessionFactory,
} from '@savoire/application'
import {
  CrdtDocumentFetcher, DocumentRoomClient,
  HttpAdminBackend, HttpAuthBackend, HttpSharingBackend, HttpVaultsBackend,
  ServerKeyProvider, SavoireServerVaultSession,
  BroadcastChannelPeerBus, LocalPeerVaultSessionFactory,
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
  // Chemins directs vers le serveur Savoire, HORS session de vault. Ils ne
  // servent plus qu'au document partage isole (ADR-027), qui n'a pas de
  // session : c'est une fonction propre au serveur. Le contenu d'un vault,
  // lui, passe entierement par sa session (voir IVaultSyncSession).
  const documentFetcher = new CrdtDocumentFetcher({ getToken, getUserId })
  const documentStore   = new DocumentStore(documentFetcher)
  const roomClient      = new DocumentRoomClient({ getToken })
  return { documentFetcher, roomClient, documentStore }
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

/** Profil local (?profile=local) : les onglets du navigateur sont les pairs. */
export function makeLocalPeerVaultSessionFactory(): IVaultSyncSessionFactory {
  return new LocalPeerVaultSessionFactory(new BroadcastChannelPeerBus())
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
