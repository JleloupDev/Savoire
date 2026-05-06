// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { AppVaultSummary, AppWorkspace, IVaultsAPI, IVaultsBackend } from './contracts'

export class VaultsService implements IVaultsAPI {
  constructor(private readonly backend: IVaultsBackend) {}

  list(userId: string, token: string): Promise<AppWorkspace> {
    return this.backend.listVaults(userId, token)
  }

  create(userId: string, name: string, token: string): Promise<AppVaultSummary> {
    return this.backend.createVault(userId, name, token)
  }

  rename(vaultId: string, name: string, token: string): Promise<AppVaultSummary> {
    return this.backend.renameVault(vaultId, name, token)
  }

  delete(vaultId: string, token: string): Promise<void> {
    return this.backend.deleteVault(vaultId, token)
  }

  addMember(vaultId: string, userId: string, role: string, token: string): Promise<void> {
    return this.backend.addMember(vaultId, userId, role, token)
  }

  removeMember(vaultId: string, memberId: string, token: string): Promise<void> {
    return this.backend.removeMember(vaultId, memberId, token)
  }
}
