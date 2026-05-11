// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { IApplicationAPI } from './contracts'
import { AuthService } from './AuthService'
import { AdminService } from './AdminService'
import { SharingService } from './SharingService'
import { VaultsService } from './VaultsService'
import { DocumentsService } from './DocumentsService'
import { DocumentSessionService } from './DocumentSessionService'
import { WorkspaceService } from './WorkspaceService'

export class ApplicationAPI implements IApplicationAPI {
  constructor(
    public readonly auth: AuthService,
    public readonly admin: AdminService,
    public readonly sharing: SharingService,
    public readonly vaults: VaultsService,
    public readonly documents: DocumentsService,
    public readonly documentSession: DocumentSessionService,
    public readonly workspace: WorkspaceService,
  ) {}
}
