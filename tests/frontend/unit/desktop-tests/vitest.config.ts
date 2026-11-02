// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Version bureau : le front Tauri (apps/desktop/src) et le profil bureau de
// l'application web (apps/web/src), sans Tauri (pont simule).
import { defineConfig } from 'vitest/config'
import path from 'path'

const pkg = (p: string) => path.resolve(__dirname, `../../../../packages/${p}/src/index.ts`)

export default defineConfig({
  resolve: {
    alias: {
      // Noyau d'indexation (indexeur de fond du bureau) et ses entrees.
      '@savoire/indexer-core/local': path.resolve(__dirname, '../../../../packages/indexer-core/src/local/index.ts'),
      '@savoire/indexer-core/tauri': path.resolve(__dirname, '../../../../packages/indexer-core/src/tauri/index.ts'),
      '@savoire/indexer-core/node': path.resolve(__dirname, '../../../../packages/indexer-core/src/node/index.ts'),
      '@savoire/indexer-core': pkg('indexer-core'),
      '@savoire/plugin-runtime': pkg('plugin-runtime'),
      '@savoire/desktop': path.resolve(__dirname, '../../../../apps/desktop/src/index.ts'),
      '@savoire/infrastructure-sync': pkg('infrastructure-sync'),
      '@savoire/application': pkg('application'),
      '@savoire/domain-sync': pkg('domain-sync'),
      '@savoire/domain-index': pkg('domain-index'),
      '@savoire/platform': pkg('platform'),
      '@savoire/notifications': pkg('notifications'),
      '@savoire/i18n': pkg('i18n'),
      '@savoire/plugin-api': pkg('plugin-api'),
      '@savoire/plugin-agent-reviewer': path.resolve(__dirname, '../../../../packages/plugins/plugin-agent-reviewer/src/index.ts'),
      // Le profil web importe le connecteur serveur : jamais de vraie connexion ici.
      '@microsoft/signalr': path.resolve(__dirname, '../infrastructure-sync-tests/src/__mocks__/signalr.ts'),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    reporters: ['verbose'],
  },
})
