// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Banc d'essai (lent, hors tests rapides) : pnpm bench, ou
// npx vitest run --config vitest.bench.config.ts
import { defineConfig } from 'vitest/config'
import { alias } from './vitest.config'

export default defineConfig({
  resolve: { alias },
  test: {
    include: ['bench/**/*.bench.ts'],
    environment: 'node',
    testTimeout: 30 * 60 * 1000,
    reporters: ['verbose'],
  },
})
