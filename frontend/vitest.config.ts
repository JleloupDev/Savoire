// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/**/src/**/*.test.ts'],
    environment: 'node',
    // Files named *.dom.test.ts run in happy-dom (needed for CodeMirror-touching tests)
    environmentMatchGlobs: [
      ['**/*.dom.test.ts', 'happy-dom'],
    ],
    reporters: ['verbose'],
  },
})
