// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { defineConfig } from 'vitest/config'
import path from 'path'

const pkg = (p: string) => path.resolve(__dirname, '../../../../packages', p)

export const alias = [
  { find: /^@savoire\/indexer-core\/node$/, replacement: pkg('indexer-core/src/node/index.ts') },
  { find: /^@savoire\/indexer-core$/, replacement: pkg('indexer-core/src/index.ts') },
  { find: /^@savoire\/plugin-api$/, replacement: pkg('plugin-api/src/index.ts') },
  { find: /^@savoire\/plugin-runtime$/, replacement: pkg('plugin-runtime/src/index.ts') },
  { find: /^@savoire\/domain-index$/, replacement: pkg('domain-index/src/index.ts') },
]

export default defineConfig({
  resolve: { alias },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    reporters: ['verbose'],
  },
})
