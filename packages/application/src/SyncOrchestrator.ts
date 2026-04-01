// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { VaultClient } from '@savoire/platform'
import type { IVaultHubFactory, VaultHubLike } from './contracts'

export class SyncOrchestrator {
  private activeHub: VaultHubLike | null = null
  private activeVaultId: string | null = null

  constructor(private readonly hubFactory: IVaultHubFactory) {}

  async attachVaultSync(vaultId: string, vaultClient: VaultClient, onChanged: () => void): Promise<VaultHubLike> {
    // Idempotent attach: keep the current hub when the target vault is unchanged.
    if (this.activeHub && this.activeVaultId === vaultId) return this.activeHub
    await this.disposeActive()
    const hub = this.hubFactory.create({ vaultId, vaultClient, onChanged })
    this.activeHub = hub
    this.activeVaultId = vaultId
    await hub.connect()
    return hub
  }

  async disposeActive(): Promise<void> {
    if (!this.activeHub) return
    await this.activeHub.dispose()
    this.activeHub = null
    this.activeVaultId = null
  }
}
