// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Tauri requires a specific server port
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3002,
    strictPort: true,
  },
  resolve: {
    // Prefer TypeScript source of workspace packages — avoids needing a build step in dev
    conditions: ['source', 'import', 'module', 'browser', 'default'],
  },
  build: {
    // Tauri uses Chromium — no need to support older browsers
    target: 'chrome105',
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
})
