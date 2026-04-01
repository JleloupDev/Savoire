// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { VaultClient } from '@savoire/platform';
import type { VaultAPI } from '@savoire/plugin-api';
import type { IWorkspaceAPI } from './contracts';
export declare class WorkspaceService implements IWorkspaceAPI {
    createVaultProxy(getClient: () => VaultClient | undefined, resolveDocId: (path: string) => string | undefined): VaultAPI;
}
//# sourceMappingURL=WorkspaceService.d.ts.map