// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { VaultClient } from '@savoire/platform';
import type { IVaultHubFactory, VaultHubLike } from './contracts';
export declare class SyncOrchestrator {
    private readonly hubFactory;
    private activeHub;
    constructor(hubFactory: IVaultHubFactory);
    attachVaultSync(vaultId: string, vaultClient: VaultClient, onChanged: () => void): Promise<VaultHubLike>;
    disposeActive(): Promise<void>;
}
//# sourceMappingURL=SyncOrchestrator.d.ts.map