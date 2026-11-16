// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Fabrique le paquet de notes d'une Bible pour le Savoire Store : les pieces
// jointes d'une release GitHub (manifest.json et notes.zip, voir
// SavoireStore/docs/publier.md). Meme code que le plugin (wol.ts, notes.ts,
// install.ts) : les notes sont celles que le plugin ecrirait.
//
//   node --experimental-strip-types --import ./scripts/ts-resolve.mjs \
//     scripts/build-notes-package.ts --out <dossier> [--bible tmn-fr] [--version 1.0.0]
//
// Les notes sont d'abord ecrites dans <dossier>/notes/ : relance, le script
// reprend ou il s'etait arrete (une note presente n'est pas relue).
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'
import { bibleById } from '../src/bibles'
import { installBible } from '../src/install'

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`)
  const v = i >= 0 ? process.argv[i + 1] : fallback
  if (v === undefined) { console.error(`--${name} manquant`); process.exit(2) }
  return v
}

const out = arg('out')
const bible = bibleById(arg('bible', 'tmn-fr'))
if (!bible) { console.error('Bible inconnue'); process.exit(2) }
const version = arg('version', '1.0.0')
const root = 'Bible/'
const notesDir = join(out, 'notes')

async function fetchText(url: string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': 'Savoire' }, redirect: 'error' })
    if (res.ok) return res.text()
    if (attempt >= 3 || res.status < 500) throw new Error(`${url} : ${res.status}`)
    await new Promise(r => setTimeout(r, 2000 * attempt))
  }
}

let last = 0
const result = await installBible({
  fetchText,
  exists: path => existsSync(join(notesDir, path)),
  createNote: async (path, text) => {
    const file = join(notesDir, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
  },
}, bible, {
  root,
  concurrency: Number(arg('concurrency', '3')),
  onProgress: p => {
    if (p.done - last >= 50 || p.done === p.total) { last = p.done; console.log(`${p.done}/${p.total} ${p.current ?? ''}`) }
  },
})
console.log(`notes : ${result.written} ecrites, ${result.skipped} deja la`)

// ── notes.zip (deflate), sans dependance ───────────────────────────────────

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? filesUnder(full) : [full]
  })
}

function zip(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8')
    const packed = deflateRawSync(data, { level: 9 })
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6) // noms en UTF-8
    local.writeUInt16LE(8, 8); local.writeUInt32LE(0, 10); local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(8, 10); central.writeUInt32LE(0, 12); central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBytes, packed)
    centrals.push(central, nameBytes)
    offset += 30 + nameBytes.length + packed.length
  }
  const dir = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, dir, end])
}

const entries = filesUnder(notesDir)
  .map(file => ({ name: relative(notesDir, file).split(sep).join('/'), data: readFileSync(file) }))
  .sort((a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true }))
writeFileSync(join(out, 'notes.zip'), zip(entries))

const manifest = {
  id: `bible-${bible.id}`,
  kind: 'notes',
  name: `Bible : ${bible.name}`,
  version,
  description: `La Bible complète en notes (${entries.length} notes, un chapitre par note), prête pour les citations du plugin Bible.`,
  longDescription: `${bible.name}, dans le dossier « ${root} » : un dossier par livre, une note par chapitre, chaque verset marqué ^numéro pour l'intégration ![[Genèse 1#^3]]. Texte lu sur ${bible.site}. Les notes déjà présentes dans le vault sont gardées.`,
  author: 'Jean Leloup',
  license: 'Texte : © Watch Tower Bible and Tract Society of Pennsylvania',
  homepage: `https://${bible.site}/`,
  categories: ['bible', 'références'],
}
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(`${join(out, 'notes.zip')} (${entries.length} notes) et manifest.json prets`)
