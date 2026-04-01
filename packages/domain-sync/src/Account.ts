// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { AccountId, VaultId } from './types'
import { Vault } from './Vault'

function trimNonEmpty(value: string, label: string): string {
  const v = value.trim()
  if (!v) throw new Error(`${label} must not be empty`)
  return v
}

export class Account {
  public readonly id: AccountId
  public displayName: string
  public email: string
  private readonly vaultsById = new Map<VaultId, Vault>()

  constructor(params: { id: AccountId; displayName: string; email: string; vaults?: Vault[] }) {
    this.id = params.id
    this.displayName = trimNonEmpty(params.displayName, 'displayName')
    this.email = trimNonEmpty(params.email, 'email')
    for (const vault of params.vaults ?? []) this.vaultsById.set(vault.id, vault)
  }

  addVault(vault: Vault): void {
    this.vaultsById.set(vault.id, vault)
  }

  removeVault(vaultId: VaultId): void {
    this.vaultsById.delete(vaultId)
  }

  getVault(vaultId: VaultId): Vault | undefined {
    return this.vaultsById.get(vaultId)
  }

  listVaults(): Vault[] {
    return Array.from(this.vaultsById.values()).sort((a, b) => a.name.localeCompare(b.name))
  }
}
