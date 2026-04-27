// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { defineConfig } from 'vitest/config'
import path from 'path'

// Alias workspace packages to their TypeScript source so tests run without
// requiring a prior `pnpm build` step.
const src = (pkg: string) =>
  path.resolve(__dirname, `../../../../packages/plugins/${pkg}/src/index.ts`)

export default defineConfig({
  resolve: {
    alias: {
      '@savoire/plugin-api': path.resolve(__dirname, '../../../../packages/plugin-api/src/index.ts'),
      '@savoire/domain-index': path.resolve(__dirname, '../../../../packages/domain-index/src/index.ts'),
      '@savoire/plugin-callout': src('plugin-callout'),
      '@savoire/plugin-filetree': src('plugin-filetree'),
      '@savoire/plugin-wikilinks': src('plugin-wikilinks'),
      '@savoire/plugin-note-embed': src('plugin-note-embed'),
      '@savoire/plugin-module': src('plugin-module'),
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

