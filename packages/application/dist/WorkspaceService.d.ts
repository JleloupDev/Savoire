import type { VaultClient } from '@poc/platform';
import type { VaultAPI } from '@poc/plugin-api';
import type { IWorkspaceAPI } from './contracts';
export declare class WorkspaceService implements IWorkspaceAPI {
    createVaultProxy(getClient: () => VaultClient | undefined, resolveDocId: (path: string) => string | undefined): VaultAPI;
}
//# sourceMappingURL=WorkspaceService.d.ts.map