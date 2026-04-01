// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  projects: [
    // ── editor-dev (:3001) — tests sans backend ───────────────────────────────
    {
      name: 'editor-dev',
      testMatch: ['editor.spec.ts', 'editor-dev.spec.ts'],
      use: {
        ...devices['Desktop Chrome'],
        baseURL: 'http://localhost:3001',
        trace: 'on-first-retry',
      },
    },
    // ── web (:3000) — flows complets avec mock API ────────────────────────────
    {
      name: 'web',
      testMatch: 'web.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: 'http://localhost:3000',
        trace: 'on-first-retry',
      },
    },
  ],
  webServer: [
    {
      name: 'editor-dev',
      command: 'pnpm --filter @savoire/editor-dev dev',
      url: 'http://localhost:3001',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      name: 'web',
      command: 'pnpm --filter @savoire/web dev',
      url: 'http://localhost:3000',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
})
