// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { IApplicationAPI } from './contracts'
import { VaultsService } from './VaultsService'
import { DocumentsService } from './DocumentsService'
import { DocumentSessionService } from './DocumentSessionService'
import { WorkspaceService } from './WorkspaceService'

export class ApplicationAPI implements IApplicationAPI {
  constructor(
    public readonly vaults: VaultsService,
    public readonly documents: DocumentsService,
    public readonly documentSession: DocumentSessionService,
    public readonly workspace: WorkspaceService,
  ) {}
}
