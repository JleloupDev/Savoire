// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { IApplicationAPI } from './contracts';
import { VaultsService } from './VaultsService';
import { DocumentsService } from './DocumentsService';
import { DocumentSessionService } from './DocumentSessionService';
import { WorkspaceService } from './WorkspaceService';
export declare class ApplicationAPI implements IApplicationAPI {
    readonly vaults: VaultsService;
    readonly documents: DocumentsService;
    readonly documentSession: DocumentSessionService;
    readonly workspace: WorkspaceService;
    constructor(vaults: VaultsService, documents: DocumentsService, documentSession: DocumentSessionService, workspace: WorkspaceService);
}
//# sourceMappingURL=ApplicationAPI.d.ts.map