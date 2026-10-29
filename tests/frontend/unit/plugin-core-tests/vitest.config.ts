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
    // Le catalogue du store importe tous les plugins : on lit leurs sources
    // (condition 'source' des paquets), pas des builds qui n'existent pas.
    conditions: ['source'],
    alias: {
      '@savoire/plugin-api': path.resolve(__dirname, '../../../../packages/plugin-api/src/index.ts'),
      '@savoire/domain-index': path.resolve(__dirname, '../../../../packages/domain-index/src/index.ts'),
      '@savoire/plugin-callout': src('plugin-callout'),
      '@savoire/plugin-filetree': src('plugin-filetree'),
      '@savoire/plugin-wikilinks': src('plugin-wikilinks'),
      '@savoire/plugin-note-embed': src('plugin-note-embed'),
      '@savoire/plugin-module': src('plugin-module'),
      '@savoire/plugin-office': src('plugin-office'),
      '@savoire/plugin-wtf': src('plugin-wtf'),
      '@savoire/plugin-chat': src('plugin-chat'),
      '@savoire/plugin-plaintext': src('plugin-plaintext'),
      '@savoire/plugin-backlinks': src('plugin-backlinks'),
      '@savoire/plugin-outline': src('plugin-outline'),
      // Avant '@savoire/plugin-page' : un alias vise aussi ses sous-chemins.
      '@savoire/plugin-page/adapter': path.resolve(__dirname, '../../../../packages/plugins/plugin-page/src/adapter/index.ts'),
      '@savoire/plugin-page': src('plugin-page'),
      '@savoire/plugin-runtime': path.resolve(__dirname, '../../../../packages/plugin-runtime/src/index.ts'),
      '@savoire/plugin-base': src('plugin-base'),
      // Moteur de requetes de l'appli (QueryEngineProvider), pour les bases de bout en bout.
      '@savoire/application': path.resolve(__dirname, '../../../../packages/application/src/index.ts'),
      '@savoire/platform': path.resolve(__dirname, '../../../../packages/platform/src/index.ts'),
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

