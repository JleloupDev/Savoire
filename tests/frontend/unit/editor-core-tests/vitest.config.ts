// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@savoire/plugin-api': path.resolve(__dirname, '../../../../packages/plugin-api/src/index.ts'),
      // Alias signalr to a mock — editor-core depends on it but the tested
      // classes (EventBus, CommandRegistry, DocumentPipeline) don't use it.
      '@microsoft/signalr': path.resolve(__dirname, './src/__mocks__/signalr.ts'),
      // Dependances d'editor-core utilisees directement par les tests : la
      // meme instance que celle du paquet (marked porte les extensions Plume).
      'marked': path.resolve(__dirname, '../../../../packages/editor-core/node_modules/marked'),
      '@codemirror/state': path.resolve(__dirname, '../../../../packages/editor-core/node_modules/@codemirror/state'),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    reporters: ['verbose'],
  },
})

