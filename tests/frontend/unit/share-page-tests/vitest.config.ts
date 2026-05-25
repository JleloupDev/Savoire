// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { defineConfig } from 'vitest/config'
import path from 'path'

const mock = (name: string) => path.resolve(__dirname, `./src/__mocks__/${name}`)

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
  },
  resolve: {
    alias: {
      '@savoire/application':   path.resolve(__dirname, '../../../../packages/application/src/index.ts'),
      '@savoire/platform':      path.resolve(__dirname, '../../../../packages/platform/src/index.ts'),
      '@savoire/plugin-api':    path.resolve(__dirname, '../../../../packages/plugin-api/src/index.ts'),
      '@savoire/editor-react':  mock('editor-react.tsx'),
      '@savoire/plugin-callout':    mock('plugin-stub.ts'),
      '@savoire/plugin-code-block': mock('plugin-stub.ts'),
      '@savoire/plugin-task-list':  mock('plugin-stub.ts'),
      '@savoire/plugin-note-embed': mock('plugin-stub.ts'),
      '@savoire/plugin-wikilinks':  mock('plugin-stub.ts'),
      '@savoire/plugin-module':     mock('plugin-stub.ts'),
      '@savoire/plugin-mermaid':    mock('plugin-stub.ts'),
      '@savoire/plugin-table':      mock('plugin-stub.ts'),
    },
  },
  test: {
    include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
    environment: 'happy-dom',
    setupFiles: ['./src/setup.ts'],
    reporters: ['verbose'],
  },
})
