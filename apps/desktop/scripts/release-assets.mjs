// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Prepare les fichiers d'une Release de l'appli de bureau (desktop.yml) :
//
// 1. Copie chaque installeur sous un nom fixe, sans version
//    (Savoire-windows-x64-setup.exe...). Le bouton de telechargement de la
//    page de connexion pointe vers releases/latest/download/<nom fixe> :
//    rien a lire ni a mettre a jour cote web.
// 2. Ecrit latest.json, lu par l'appli pour ses mises a jour
//    (tauri-plugin-updater) : version, notes, et pour chaque systeme
//    l'adresse du fichier et sa signature.
//
//   node release-assets.mjs <dossier des builds> <dossier de sortie> <tag> <depot>
//
// Les noms fixes sont aussi dans apps/web/src/downloads.ts.

import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'

/** Fichier du build (fin du nom) -> nom fixe, et cibles de l'updater qu'il sert. */
export const ASSETS = [
  { suffix: '-setup.exe', name: 'Savoire-windows-x64-setup.exe', targets: ['windows-x86_64', 'windows-x86_64-nsis'] },
  { suffix: '.msi', name: 'Savoire-windows-x64.msi', targets: ['windows-x86_64-msi'] },
  { suffix: '.dmg', name: 'Savoire-macos-arm64.dmg', targets: [] },
  { suffix: '.app.tar.gz', name: 'Savoire-macos-arm64.app.tar.gz', targets: ['darwin-aarch64', 'darwin-aarch64-app'] },
  { suffix: '.AppImage', name: 'Savoire-linux-x86_64.AppImage', targets: ['linux-x86_64', 'linux-x86_64-appimage'] },
  // .deb et .rpm : mis a jour seulement si le build les a signes. Sinon, leur
  // updater ne trouve pas sa cible et l'appli reste a sa version (sans casse).
  { suffix: '.deb', name: 'Savoire-linux-amd64.deb', targets: ['linux-x86_64-deb'], optionalSig: true },
  { suffix: '.rpm', name: 'Savoire-linux-x86_64.rpm', targets: ['linux-x86_64-rpm'], optionalSig: true },
]

function walk(dir) {
  return readdirSync(dir).flatMap(entry => {
    const path = join(dir, entry)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

export function prepareRelease(inDir, outDir, tag, repo, notes = '') {
  const files = walk(inDir)
  const version = tag.replace(/^v/, '')
  const platforms = {}
  mkdirSync(outDir, { recursive: true })
  for (const asset of ASSETS) {
    const found = files.filter(f => basename(f).endsWith(asset.suffix))
    if (found.length !== 1) throw new Error(`${asset.name} : ${found.length} fichier(s) en *${asset.suffix} au lieu d'un (${found.map(f => basename(f)).join(', ')})`)
    copyFileSync(found[0], join(outDir, asset.name))
    if (asset.targets.length === 0) continue
    const sig = files.find(f => f === `${found[0]}.sig`)
    if (!sig && asset.optionalSig) continue
    if (!sig) throw new Error(`${asset.name} : pas de signature (${basename(found[0])}.sig)`)
    const url = `https://github.com/${repo}/releases/download/${tag}/${asset.name}`
    const signature = readFileSync(sig, 'utf8').trim()
    for (const target of asset.targets) platforms[target] = { url, signature }
  }
  const manifest = { version, notes, pub_date: new Date().toISOString(), platforms }
  writeFileSync(join(outDir, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n')
  return manifest
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
  const [inDir, outDir, tag, repo] = process.argv.slice(2)
  if (!inDir || !outDir || !tag || !repo) {
    console.error('usage : node release-assets.mjs <builds> <sortie> <tag> <depot>')
    process.exit(2)
  }
  let manifest
  try {
    manifest = prepareRelease(inDir, outDir, tag, repo, `Savoire ${tag}`)
  } catch (e) {
    // Annotation GitHub : lisible sans ouvrir le journal.
    console.log(`::error title=Fichiers de la Release::${String(e?.message ?? e).replace(/%/g, '%25').replace(/\n/g, '%0A')}`)
    process.exit(1)
  }
  console.log(`latest.json : ${manifest.version}, ${Object.keys(manifest.platforms).join(', ')}`)
}
