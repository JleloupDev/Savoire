// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { AppVaultSummary, IVaultsAPI, IVaultsBackend } from './contracts';
export declare class VaultsService implements IVaultsAPI {
    private readonly backend;
    constructor(backend: IVaultsBackend);
    list(userId: string, token: string): Promise<AppVaultSummary[]>;
    create(userId: string, name: string, token: string): Promise<AppVaultSummary>;
    rename(vaultId: string, name: string, token: string): Promise<AppVaultSummary>;
    delete(vaultId: string, token: string): Promise<void>;
}
//# sourceMappingURL=VaultsService.d.ts.map