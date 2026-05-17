// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import {
  AppRoot, AuthService, AdminService, SharingService,
  type IVaultHubFactory, type IVaultsBackend,
} from '@savoire/application'
import {
  CrdtDocumentFetcher, DocumentRoomClient,
  HttpAdminBackend, HttpAuthBackend, HttpSharingBackend, HttpVaultsBackend,
  RestDocumentFetcher, RestVaultStorage,
} from '@savoire/infrastructure-sync'
import { DocumentStore } from '@savoire/platform'
import type { VaultAPI } from '@savoire/plugin-api'
import { VaultHubClient } from './VaultHubClient'

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
  const restFetcher     = new RestDocumentFetcher()
  const vaultStorage    = new RestVaultStorage()
  const documentStore   = new DocumentStore(documentFetcher, restFetcher)
  const roomClient      = new DocumentRoomClient({ getToken })
  return { documentFetcher, restFetcher, vaultStorage, roomClient, documentStore }
}

// ── AppRoot factory ───────────────────────────────────────────────────────────

export interface CreateWebAppRootParams {
  documentStore: DocumentStore
  getToken: () => string | null
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
  return new AppRoot({
    adminBackend,
    authBackend,
    sharingBackend,
    backend,
    hubFactory: makeHubFactory(params.getToken, params.onConnectionChange),
    documentStore: params.documentStore,
  })
}

// ── DirectVaultAPI — VaultAPI minimale via REST (pages de visualisation) ──────

export class DirectVaultAPI implements VaultAPI {
  private readonly fetcher: RestDocumentFetcher

  constructor(
    private readonly vaultId: string,
    private readonly token: string,
    private readonly docId: string,
    private readonly path: string,
    baseUrl?: string,
  ) {
    this.fetcher = new RestDocumentFetcher({ baseUrl: baseUrl ?? '' })
  }

  async read(documentId: string): Promise<string> {
    return this.fetcher.getDocumentContent(this.vaultId, documentId, this.token)
  }

  async readDocumentByPath(path: string): Promise<string> {
    const resolved = this.resolveDocumentId(path)
    if (!resolved) throw new Error(`Document introuvable pour path: ${path}`)
    return this.read(resolved)
  }

  async write(documentId: string, content: string): Promise<void> {
    return this.fetcher.writeDocumentContent(this.vaultId, documentId, content, this.token)
  }

  async list(dir?: string): Promise<string[]> {
    const prefix = dir ? (dir.endsWith('/') ? dir : `${dir}/`) : ''
    return this.path.startsWith(prefix) ? [this.path] : []
  }

  async exists(documentId: string): Promise<boolean> {
    try { await this.read(documentId); return true } catch { return false }
  }

  resolveDocumentId(path: string): string | undefined {
    if (path === this.path) return this.docId
    if (!path.includes('.') && `${path}.md` === this.path) return this.docId
    return undefined
  }

  getVaultId(): string { return this.vaultId }
  getToken(): string   { return this.token }
}

// ── DocumentRoomClient factory (pour les pages de visualisation) ───────────────

export function createDocumentRoomClient(params: { serverUrl?: string; getToken: () => string }) {
  return new DocumentRoomClient({ serverUrl: params.serverUrl ?? '', getToken: params.getToken })
}
