// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@savoire/infrastructure-sync': path.resolve(__dirname, '../../../../packages/infrastructure-sync/src/index.ts'),
      '@savoire/infrastructure-edgesync': path.resolve(__dirname, '../../../../packages/infrastructure-edgesync/src/index.ts'),
      '@savoire/domain-sync': path.resolve(__dirname, '../../../../packages/domain-sync/src/index.ts'),
      '@savoire/plugin-api': path.resolve(__dirname, '../../../../packages/plugin-api/src/index.ts'),
      '@savoire/domain-index': path.resolve(__dirname, '../../../../packages/domain-index/src/index.ts'),
      '@savoire/platform': path.resolve(__dirname, '../../../../packages/platform/src/index.ts'),
      '@microsoft/signalr': path.resolve(__dirname, './src/__mocks__/signalr.ts'),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    reporters: ['verbose'],
  },
})

