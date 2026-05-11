// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { DocumentStore } from '@savoire/platform'
import type { IApplicationAPI, IAdminBackend, IAuthBackend, ISharingBackend, IVaultHubFactory, IVaultsBackend } from './contracts'
import { ApplicationAPI } from './ApplicationAPI'
import { AuthService } from './AuthService'
import { AdminService } from './AdminService'
import { SharingService } from './SharingService'
import { VaultsService } from './VaultsService'
import { DocumentsService } from './DocumentsService'
import { DocumentSessionService } from './DocumentSessionService'
import { WorkspaceService } from './WorkspaceService'
import { SyncOrchestrator } from './SyncOrchestrator'

export interface AppRootDeps {
  authBackend: IAuthBackend
  adminBackend: IAdminBackend
  sharingBackend: ISharingBackend
  backend: IVaultsBackend
  hubFactory: IVaultHubFactory
  documentStore: DocumentStore
}

export class AppRoot {
  public readonly api: IApplicationAPI

  constructor(deps: AppRootDeps) {
    const auth = new AuthService(deps.authBackend)
    const admin = new AdminService(deps.adminBackend)
    const sharing = new SharingService(deps.sharingBackend)
    const vaults = new VaultsService(deps.backend)
    const sync = new SyncOrchestrator(deps.hubFactory)
    const documents = new DocumentsService(deps.backend, sync)
    const documentSession = new DocumentSessionService(deps.documentStore)
    const workspace = new WorkspaceService()
    this.api = new ApplicationAPI(auth, admin, sharing, vaults, documents, documentSession, workspace)
  }
}
