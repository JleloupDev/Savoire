// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { fileURLToPath } from 'node:url'
import { build as viteBuild, defineConfig, searchForWorkspaceRoot, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve, join } from 'path'
import { createRequire } from 'module'
import { cpSync, existsSync, createReadStream, statSync, realpathSync, mkdirSync, writeFileSync } from 'fs'
import { execSync } from 'child_process'

// Le commit construit, affiche dans l'en-tete (src/BuildInfo.tsx). L'image
// Docker n'a pas le dossier .git : la CI passe SAVOIRE_COMMIT et
// SAVOIRE_COMMIT_DATE. Ailleurs (dev, appli de bureau), git les donne.
function gitInfo(format: string): string {
  try { return execSync(`git log -1 --format=${format}`, { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() } catch { return '' }
}
const buildCommit = process.env.SAVOIRE_COMMIT || gitInfo('%H')
const buildCommitDate = process.env.SAVOIRE_COMMIT_DATE || gitInfo('%cI')

// Les polices d'Excalidraw, servies par l'app au lieu du CDN : l'appli de
// bureau doit marcher hors ligne et sa CSP interdit unpkg. Depuis la 0.18,
// les langues et le code differe sont des modules ordinaires (Vite les
// range dans le paquet) ; seules les polices se lisent a l'execution, sous
// EXCALIDRAW_ASSET_PATH (src/excalidrawAssets.ts) + « fonts/ ».
function excalidrawAssets(): Plugin {
  const req = createRequire(resolve(__dirname, '../../packages/plugins/plugin-excalidraw/package.json'))
  // Le paquet n'exporte plus package.json : on remonte de son point d'entree
  // (dist/prod/index.js) a son dossier dist.
  const dist = resolve(req.resolve('@excalidraw/excalidraw'), '..', '..')
  let outDir = 'dist'
  return {
    name: 'savoire-excalidraw-assets',
    configResolved(config) { outDir = resolve(config.root, config.build.outDir) },
    configureServer(server) {
      // En dev, Excalidraw (version developpement) lit dist/dev.
      const root = join(dist, 'dev')
      server.middlewares.use('/excalidraw-assets', (req, res, next) => {
        const file = join(root, decodeURIComponent((req.url ?? '/').split('?')[0]))
        if (!file.startsWith(join(root, 'fonts')) || !existsSync(file) || !statSync(file).isFile()) return next()
        createReadStream(file).pipe(res)
      })
    },
    closeBundle() { cpSync(join(dist, 'prod', 'fonts'), join(outDir, 'excalidraw-assets', 'fonts'), { recursive: true }) },
  }
}

// Les bibliotheques fournies aux applications (plugin-app) : React en modules
// ES, servis sous /app-libs/. Le cadre d'une application (origine opaque) ne
// lit pas les adresses de l'appli : l'appli les lit et les lui passe, il en
// fait des adresses blob: nommees par sa carte d'import. Chaque fichier est
// construit a part, React laisse dehors (une seule copie, celle de react.js).
const APP_LIBS: { file: string; id: string; external: string[] }[] = [
  { file: 'react.js', id: 'react', external: [] },
  { file: 'react-dom.js', id: 'react-dom', external: ['react'] },
  { file: 'react-dom-client.js', id: 'react-dom/client', external: ['react', 'react-dom'] },
  { file: 'react-jsx-runtime.js', id: 'react/jsx-runtime', external: ['react'] },
]

async function buildAppLibrary(lib: { id: string; external: string[] }): Promise<string> {
  // Les noms exportes, lus sur le module CommonJS lui-meme : un module ES a
  // besoin de les declarer un par un.
  const names = Object.keys(createRequire(resolve(__dirname, 'package.json'))(lib.id) as Record<string, unknown>)
    .filter(n => n !== 'default' && /^[A-Za-z_$][\w$]*$/.test(n))
  const entry = `import * as M from ${JSON.stringify(lib.id)}\nconst m = M.default ?? M\nexport default m\n`
    + names.map(n => `export const ${n} = m.${n}`).join('\n') + '\n'
  const out = await viteBuild({
    configFile: false, root: __dirname, logLevel: 'silent', mode: 'production',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{
      name: 'savoire-app-lib-entry',
      resolveId: (id: string) => (id === 'savoire-app-lib-entry' ? '\0savoire-app-lib-entry' : null),
      load: (id: string) => (id === '\0savoire-app-lib-entry' ? entry : null),
    }],
    build: {
      write: false, minify: true, copyPublicDir: false,
      rollupOptions: {
        input: 'savoire-app-lib-entry', external: lib.external, preserveEntrySignatures: 'strict',
        output: { format: 'es', entryFileNames: 'lib.js', inlineDynamicImports: true },
      },
    },
  })
  const outputs = (Array.isArray(out) ? out : [out]) as { output: { type: string; isEntry?: boolean; code?: string }[] }[]
  const chunk = outputs.flatMap(o => o.output).find(c => c.type === 'chunk' && c.isEntry)
  if (!chunk?.code) throw new Error(`bibliotheque d'application ${lib.id} : rien de construit`)
  return chunk.code
}

function appLibraries(): Plugin {
  const cache = new Map<string, Promise<string>>()
  const get = (lib: (typeof APP_LIBS)[number]) => {
    let p = cache.get(lib.file)
    if (!p) { p = buildAppLibrary(lib); cache.set(lib.file, p); p.catch(() => cache.delete(lib.file)) }
    return p
  }
  let outDir = 'dist'
  let isBuild = false
  return {
    name: 'savoire-app-libraries',
    configResolved(config) { outDir = resolve(config.root, config.build.outDir); isBuild = config.command === 'build' },
    configureServer(server) {
      server.middlewares.use('/app-libs', (req, res, next) => {
        const lib = APP_LIBS.find(l => `/${l.file}` === (req.url ?? '').split('?')[0])
        if (!lib) return next()
        get(lib).then(code => {
          res.setHeader('Content-Type', 'text/javascript; charset=utf-8')
          res.end(code)
        }, err => { res.statusCode = 500; res.end(String(err)) })
      })
    },
    async closeBundle() {
      if (!isBuild) return
      mkdirSync(join(outDir, 'app-libs'), { recursive: true })
      for (const lib of APP_LIBS) writeFileSync(join(outDir, 'app-libs', lib.file), await get(lib))
    },
  }
}

// Le moteur d'OCR (tesseract.js, plugin-images) : son worker et ses noyaux
// WebAssembly, servis par l'app au lieu du CDN jsdelivr. La CSP de l'appli
// n'admet que ses propres scripts. Voir plugin-images, tesseractOcr.
function tesseractAssets(): Plugin {
  const req = createRequire(resolve(__dirname, '../../packages/plugins/plugin-images/package.json'))
  const jsDir = resolve(req.resolve('tesseract.js/package.json'), '..')
  const coreReq = createRequire(join(jsDir, 'package.json'))
  const coreDir = resolve(coreReq.resolve('tesseract.js-core/package.json'), '..')
  const files: Record<string, string> = { 'worker.min.js': join(jsDir, 'dist', 'worker.min.js') }
  for (const v of ['', '-lstm', '-simd', '-simd-lstm', '-relaxedsimd', '-relaxedsimd-lstm']) {
    files[`tesseract-core${v}.wasm.js`] = join(coreDir, `tesseract-core${v}.wasm.js`)
  }
  let outDir = 'dist'
  return {
    name: 'savoire-tesseract-assets',
    configResolved(config) { outDir = resolve(config.root, config.build.outDir) },
    configureServer(server) {
      server.middlewares.use('/vendor/tesseract', (req, res, next) => {
        const file = files[decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\//, '')]
        if (!file) return next()
        res.setHeader('Content-Type', 'text/javascript')
        createReadStream(file).pipe(res)
      })
    },
    closeBundle() {
      for (const [name, file] of Object.entries(files)) cpSync(file, join(outDir, 'vendor', 'tesseract', name))
    },
  }
}

// Les fichiers de pdf.js (plugin-pdf) que la bibliotheque charge a la demande :
// decodeurs WebAssembly des images (JBIG2, JPEG 2000 : les PDF scannes),
// polices standard, tables de caracteres (CJK). Servis par l'app, comme
// Tesseract : l'appli de bureau marche hors ligne. Voir plugin-pdf, pdfjs.ts.
function pdfjsAssets(): Plugin {
  const req = createRequire(resolve(__dirname, '../../packages/plugins/plugin-pdf/package.json'))
  const root = resolve(req.resolve('pdfjs-dist/package.json'), '..')
  const dirs = ['wasm', 'standard_fonts', 'cmaps']
  const types: Record<string, string> = { wasm: 'application/wasm', js: 'text/javascript', ttf: 'font/ttf', pfb: 'application/octet-stream', bcmap: 'application/octet-stream' }
  let outDir = 'dist'
  return {
    name: 'savoire-pdfjs-assets',
    configResolved(config) { outDir = resolve(config.root, config.build.outDir) },
    configureServer(server) {
      server.middlewares.use('/vendor/pdfjs', (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '')
        const [dir, name, ...rest] = rel.split('/')
        if (!dir || !dirs.includes(dir) || !name || rest.length || name.includes('..')) return next()
        const file = join(root, dir, name)
        if (!existsSync(file) || !statSync(file).isFile()) return next()
        res.setHeader('Content-Type', types[name.split('.').pop() ?? ''] ?? 'application/octet-stream')
        createReadStream(file).pipe(res)
      })
    },
    closeBundle() {
      for (const dir of dirs) cpSync(join(root, dir), join(outDir, 'vendor', 'pdfjs', dir), { recursive: true })
    },
  }
}

// Dossier du paquet SQLite WebAssembly (index local) : son .wasm est servi en
// dev depuis node_modules (hors des dossiers que Vite sert par defaut).
// Les polices d'Excalidraw 0.18 : sa feuille de style les vise par chemin
// relatif, que Vite sert en dev par /@fs/ (hors du dossier du workspace).
const excalidrawDir = realpathSync(resolve(createRequire(resolve(__dirname, '../../packages/plugins/plugin-excalidraw/package.json')).resolve('@excalidraw/excalidraw'), '..', '..'))

const sqliteWasmDir = realpathSync(resolve(
  createRequire(resolve(__dirname, '../../packages/indexer-core/package.json')).resolve('@sqlite.org/sqlite-wasm/package.json'), '..'))

export default defineConfig({
  plugins: [react(), excalidrawAssets(), tesseractAssets(), pdfjsAssets(), appLibraries()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
      },
    },
  },
  // Index local du navigateur (ADR-027) : SQLite WebAssembly dans un Worker
  // module (src/localIndexWorker.ts). Le paquet charge son .wasm par
  // new URL(..., import.meta.url) : ni pre-bundle en dev (le chemin casserait),
  // et le .wasm est copie tel quel au build.
  optimizeDeps: {
    // Le moteur LaTeX (plugin-latex) charge aussi son worker par adresse.
    exclude: ['@sqlite.org/sqlite-wasm', '@siglum/engine'],
  },
  worker: {
    format: 'es',
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'development'),
    __SAVOIRE_COMMIT__: JSON.stringify(buildCommit),
    __SAVOIRE_COMMIT_DATE__: JSON.stringify(buildCommitDate),
  },
  server: {
    port: 3000,
    fs: { allow: [searchForWorkspaceRoot(process.cwd()), sqliteWasmDir, excalidrawDir] },
    proxy: {
      '/api': 'http://localhost:5000',
      // Pages publiees sur le web : rendues par l'API.
      '/p/': 'http://localhost:5000',
      // Metadonnees OAuth du MCP (ChatGPT, Claude.ai) : servies par l'API.
      '/.well-known/oauth-': 'http://localhost:5000',
      // Savoire Store (depot voisin SavoireStore), en developpement.
      '/store': {
        target: 'http://127.0.0.1:5100',
        rewrite: (path: string) => path.replace(/^\/store/, '') || '/',
      },
      '/hubs': {
        target: 'http://localhost:5000',
        ws: true,
      },
    },
  },
  resolve: {
    // Prefer TypeScript source of workspace packages — avoids needing a build step in dev
    conditions: ['source', 'import', 'module', 'browser', 'default'],
    alias: {
      // Moteur LaTeX (plugin-latex) : acceleration optionnelle non constructible, desactivee.
      'blake3-wasm/browser.js': fileURLToPath(new URL('./src/blake3-disabled.js', import.meta.url)),
    },
  },

})
