// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve, join } from 'path'
import { createRequire } from 'module'
import { cpSync, existsSync, createReadStream, statSync } from 'fs'

// Les morceaux d'Excalidraw (polices, langues, code differe), servis par
// l'app au lieu du CDN : l'appli de bureau doit marcher hors ligne et sa CSP
// interdit unpkg. Voir src/excalidrawAssets.ts.
function excalidrawAssets(): Plugin {
  const req = createRequire(resolve(__dirname, '../../packages/plugins/plugin-excalidraw/package.json'))
  const dist = join(resolve(req.resolve('@excalidraw/excalidraw/package.json'), '..'), 'dist')
  const dir = join(dist, 'excalidraw-assets')
  let outDir = 'dist'
  return {
    name: 'savoire-excalidraw-assets',
    configResolved(config) { outDir = resolve(config.root, config.build.outDir) },
    configureServer(server) {
      // En dev, Excalidraw (version developpement) lit excalidraw-assets-dev.
      for (const name of ['excalidraw-assets', 'excalidraw-assets-dev']) {
        const root = join(dist, name)
        server.middlewares.use(`/${name}`, (req, res, next) => {
          const file = join(root, decodeURIComponent((req.url ?? '/').split('?')[0]))
          if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) return next()
          if (file.endsWith('.js')) res.setHeader('Content-Type', 'text/javascript')
          createReadStream(file).pipe(res)
        })
      }
    },
    closeBundle() { cpSync(dir, join(outDir, 'excalidraw-assets'), { recursive: true }) },
  }
}

export default defineConfig({
  plugins: [react(), excalidrawAssets()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
      },
    },
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'development'),
  },
  server: {
    port: 3000,
    proxy: {
      '/api': 'http://localhost:5000',
      '/hubs': {
        target: 'http://localhost:5000',
        ws: true,
      },
    },
  },
  resolve: {
    // Prefer TypeScript source of workspace packages — avoids needing a build step in dev
    conditions: ['source', 'import', 'module', 'browser', 'default'],
  },
})
