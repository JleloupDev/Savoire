// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { AccountId, VaultId } from './types';
import { Vault } from './Vault';
export declare class Account {
    readonly id: AccountId;
    displayName: string;
    email: string;
    private readonly vaultsById;
    constructor(params: {
        id: AccountId;
        displayName: string;
        email: string;
        vaults?: Vault[];
    });
    addVault(vault: Vault): void;
    removeVault(vaultId: VaultId): void;
    getVault(vaultId: VaultId): Vault | undefined;
    listVaults(): Vault[];
}
//# sourceMappingURL=Account.d.ts.map