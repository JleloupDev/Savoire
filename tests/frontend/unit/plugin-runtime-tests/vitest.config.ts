// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@savoire/plugin-api': path.resolve(__dirname, '../../../../packages/plugin-api/src/index.ts'),
      '@savoire/plugin-runtime': path.resolve(__dirname, '../../../../packages/plugin-runtime/src/index.ts'),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    environmentMatchGlobs: [
      ['**/*.dom.test.ts', 'happy-dom'],
    ],
    reporters: ['verbose'],
  },
})

