// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { AppRoot, type IVaultHubFactory, type IVaultsBackend } from '@savoire/application'
import { HttpVaultsBackend } from '@savoire/infrastructure-sync'
import type { DocumentStore } from '@savoire/platform'
import { VaultHubClient } from './VaultHubClient'

export interface CreateWebAppRootParams {
  documentStore: DocumentStore
  getToken: () => string | null
  onConnectionChange?: (state: 'connected' | 'disconnected') => void
}

const backend: IVaultsBackend = new HttpVaultsBackend()

function makeHubFactory(
  getToken: () => string | null,
  onConnectionChange?: (state: 'connected' | 'disconnected') => void,
): IVaultHubFactory {
  return {
    create: ({ vaultId, vaultClient, onChanged }) =>
      new VaultHubClient('', vaultId, vaultClient, onChanged, getToken, onConnectionChange),
  }
}

export function createWebAppRoot(params: CreateWebAppRootParams): AppRoot {
  return new AppRoot({
    backend,
    hubFactory: makeHubFactory(params.getToken, params.onConnectionChange),
    documentStore: params.documentStore,
  })
}
