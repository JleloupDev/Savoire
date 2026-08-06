// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { AppVaultSummary, AppWorkspace, IVaultsAPI, IVaultsBackend } from './contracts'

export class VaultsService implements IVaultsAPI {
  constructor(private readonly backend: IVaultsBackend) {}

  list(userId: string, token: string): Promise<AppWorkspace> {
    return this.backend.listVaults(userId, token)
  }

  create(userId: string, name: string, token: string, isManaged: boolean): Promise<AppVaultSummary> {
    return this.backend.createVault(userId, name, token, isManaged)
  }

  rename(vaultId: string, name: string, token: string): Promise<AppVaultSummary> {
    return this.backend.renameVault(vaultId, name, token)
  }

  delete(vaultId: string, token: string): Promise<void> {
    return this.backend.deleteVault(vaultId, token)
  }

}
