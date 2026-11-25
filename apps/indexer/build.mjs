// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Construit le pair indexeur en UN fichier : dist/indexer.mjs (Node 24, ESM).
// Les paquets du depot (indexer-core, plugin-api, domain-index) et yjs y
// sont inclus ; les modules integres de Node (node:*) restent externes.
//   node build.mjs            construction
//   node build.mjs --watch    reconstruction a chaque modification
import { cpSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))

// Les fichiers que pdf.js lit a la demande (decodeurs WebAssembly des images
// JBIG2 et JPEG 2000 des PDF scannes, polices standard, tables de caracteres) :
// copies a cote du paquet, dans dist/pdfjs/ (voir src/extractors.ts).
const pdfjsRoot = dirname(createRequire(join(here, '../../packages/plugins/plugin-pdf/package.json')).resolve('pdfjs-dist/package.json'))
for (const dir of ['wasm', 'standard_fonts', 'cmaps']) cpSync(join(pdfjsRoot, dir), join(here, 'dist/pdfjs', dir), { recursive: true })

const options = {
  entryPoints: [join(here, 'src/main.ts')],
  outfile: join(here, 'dist/indexer.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  // Sources TypeScript des paquets du depot (exports « source »).
  conditions: ['source'],
  sourcemap: 'linked',
  legalComments: 'none',
  logLevel: 'info',
  define: { __INDEXER_VERSION__: JSON.stringify(pkg.version) },
  // Tesseract (OCR des images) lance un worker depuis ses propres fichiers :
  // il reste un module installe a cote (voir Dockerfile), pas empaquete.
  // Le canvas de pdf.js (pages scannees a dessiner pour l'OCR) est un module
  // natif, que pdf.js charge lui-meme : installe a cote aussi.
  external: ['tesseract.js', '@napi-rs/canvas'],
  // require() de modules integres dans du code CommonJS empaquete.
  banner: { js: "import { createRequire as __savoireRequire } from 'node:module'; const require = __savoireRequire(import.meta.url);" },
}

if (process.argv.includes('--watch')) {
  const ctx = await esbuild.context(options)
  await ctx.watch()
} else {
  const result = await esbuild.build({ ...options, metafile: true })
  const out = Object.entries(result.metafile.outputs).find(([f]) => f.endsWith('.mjs'))
  console.log(`dist/indexer.mjs : ${Math.round(out[1].bytes / 1024)} Kio`)
}
