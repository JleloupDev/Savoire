// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { DocumentStore } from '@savoire/platform'
import type { IIdentityProvider } from '@savoire/plugin-api'
import type { IApplicationAPI, IAdminBackend, IAuthBackend, ISharingBackend, IVaultsBackend, IVaultSyncSessionFactory } from './contracts'
import { ApplicationAPI } from './ApplicationAPI'
import { AuthService } from './AuthService'
import { AdminService } from './AdminService'
import { SharingService } from './SharingService'
import { VaultsService } from './VaultsService'
import { DocumentsService } from './DocumentsService'
import { DocumentSessionService } from './DocumentSessionService'
import { WorkspaceService } from './WorkspaceService'

export interface AppRootDeps {
  authBackend: IAuthBackend
  adminBackend: IAdminBackend
  sharingBackend: ISharingBackend
  backend: IVaultsBackend
  /** Le profil de synchronisation : serveur Savoire, EdgeSync, ou demain
   *  automerge-repo. Un seul port, choisi ici. Voir IVaultSyncSession. */
  vaultSyncSessionFactory: IVaultSyncSessionFactory
  documentStore: DocumentStore
  identityProvider?: IIdentityProvider
}

export class AppRoot {
  public readonly api: IApplicationAPI
  public readonly identityProvider: IIdentityProvider | undefined

  constructor(deps: AppRootDeps) {
    const auth = new AuthService(deps.authBackend)
    const admin = new AdminService(deps.adminBackend)
    const sharing = new SharingService(deps.sharingBackend)
    const vaults = new VaultsService(deps.backend)
    const documents = new DocumentsService(deps.vaultSyncSessionFactory)
    const documentSession = new DocumentSessionService(deps.documentStore)
    const workspace = new WorkspaceService()
    this.api = new ApplicationAPI(auth, admin, sharing, vaults, documents, documentSession, workspace)
    this.identityProvider = deps.identityProvider
  }
}
