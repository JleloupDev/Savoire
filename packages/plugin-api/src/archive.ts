// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Lecture d'une archive .zip, sans dependance : le repertoire central, puis
// chaque entree, stockee telle quelle (methode 0) ou compressee (methode 8,
// « deflate », decompressee par DecompressionStream, present dans les
// navigateurs recents et Node 18+).
//
// Une archive dans l'archive (les exports Notion en plusieurs parties) est
// ouverte a son tour, a sa place.
//
// Limites : pas de zip64 (archives de plus de 4 Gio ou de 65 535 entrees),
// pas de chiffrement.

export interface ArchiveFile {
  /** Chemin dans l'archive, separe par « / ». */
  path: string
  bytes: Uint8Array
}

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
/** Une archive imbriquee n'est ouverte que jusqu'a cette profondeur. */
const MAX_DEPTH = 3

export class ZipFormatError extends Error {}

/** Toutes les entrees (fichiers) de l'archive, archives imbriquees ouvertes. */
export async function readZip(bytes: Uint8Array, depth = 0): Promise<ArchiveFile[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const eocd = findEndOfCentralDirectory(view)
  const count = view.getUint16(eocd + 10, true)
  let offset = view.getUint32(eocd + 16, true)
  if (count === 0xffff || offset === 0xffffffff) throw new ZipFormatError('Archive zip64 non prise en charge : découpez l’export en plusieurs parties.')
  const files: ArchiveFile[] = []
  const utf8 = new TextDecoder('utf-8')
  const latin = new TextDecoder('latin1')
  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== CENTRAL_SIGNATURE) throw new ZipFormatError('Répertoire de l’archive illisible.')
    const flags = view.getUint16(offset + 8, true)
    const method = view.getUint16(offset + 10, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const localOffset = view.getUint32(offset + 42, true)
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength)
    // Drapeau 0x0800 : noms en UTF-8. Sans lui, la plupart des outils ecrivent quand meme de l'UTF-8.
    const path = (flags & 0x0800 ? utf8 : guessDecoder(nameBytes, utf8, latin)).decode(nameBytes).replace(/\\/g, '/')
    offset += 46 + nameLength + extraLength + commentLength
    if (path.endsWith('/')) continue
    if (flags & 0x0001) throw new ZipFormatError(`Fichier chiffré dans l’archive : ${path}`)
    if (view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) throw new ZipFormatError(`Entrée illisible : ${path}`)
    const localName = view.getUint16(localOffset + 26, true)
    const localExtra = view.getUint16(localOffset + 28, true)
    const start = localOffset + 30 + localName + localExtra
    const raw = bytes.subarray(start, start + compressedSize)
    let data: Uint8Array
    if (method === 0) data = raw
    else if (method === 8) data = await inflate(raw)
    else throw new ZipFormatError(`Méthode de compression ${method} non prise en charge : ${path}`)
    if (depth < MAX_DEPTH && /\.zip$/i.test(path)) {
      // Export en plusieurs parties : l'archive interne prend la place de son fichier.
      const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : ''
      for (const inner of await readZip(data, depth + 1)) files.push({ path: dir + inner.path, bytes: inner.bytes })
      continue
    }
    files.push({ path, bytes: data })
  }
  return files
}

function findEndOfCentralDirectory(view: DataView): number {
  // Le commentaire de fin fait au plus 65 535 octets.
  const min = Math.max(0, view.byteLength - 22 - 0xffff)
  for (let i = view.byteLength - 22; i >= min; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) return i
  }
  throw new ZipFormatError('Ce fichier n’est pas une archive .zip.')
}

function guessDecoder(bytes: Uint8Array, utf8: TextDecoder, latin: TextDecoder): TextDecoder {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return utf8
  } catch {
    return latin
  }
}

async function inflate(raw: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([raw as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

// ── Ecriture ──────────────────────────────────────────────────────────────
//
// Archive .zip minimale, sans compression (methode « stored ») : de quoi
// exporter un vault ou une presentation (.pptx) depuis le navigateur, sans
// dependance. Les images sont deja compressees ; les textes sont petits.
// Noms en UTF-8 (drapeau 0x0800). Limites du format classique (sans zip64) :
// 65 535 entrees, 4 Gio.

export interface ZipEntry {
  /** Chemin dans l'archive, separe par « / ». Un chemin fini par « / » est un dossier. */
  path: string
  bytes?: Uint8Array
  /** Date de modification. Defaut : maintenant. */
  date?: Date
}

const MAX_ENTRIES = 0xffff
const MAX_SIZE = 0xffffffff

let crcTable: Uint32Array | null = null

function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** Date et heure au format MS-DOS (pas de 2 secondes, a partir de 1980). */
function dosDateTime(date: Date): { time: number; day: number } {
  const year = Math.max(1980, date.getFullYear())
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    day: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

/** Construit l'archive. Rejette au-dela des limites du format classique. */
export function createZip(entries: readonly ZipEntry[]): Blob {
  if (entries.length > MAX_ENTRIES) throw new Error(`archive trop grande : ${entries.length} fichiers (maximum ${MAX_ENTRIES})`)
  const encoder = new TextEncoder()
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const name = encoder.encode(entry.path)
    const data = entry.bytes ?? new Uint8Array()
    const crc = crc32(data)
    const { time, day } = dosDateTime(entry.date ?? new Date())
    if (data.length > MAX_SIZE || offset > MAX_SIZE) throw new Error('archive trop grande (plus de 4 Gio)')

    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, 20, true)
    local.setUint16(6, 0x0800, true)
    local.setUint16(8, 0, true)
    local.setUint16(10, time, true)
    local.setUint16(12, day, true)
    local.setUint32(14, crc, true)
    local.setUint32(18, data.length, true)
    local.setUint32(22, data.length, true)
    local.setUint16(26, name.length, true)
    local.setUint16(28, 0, true)
    parts.push(new Uint8Array(local.buffer), name, data)

    const dir = new DataView(new ArrayBuffer(46))
    dir.setUint32(0, 0x02014b50, true)
    dir.setUint16(4, 20, true)
    dir.setUint16(6, 20, true)
    dir.setUint16(8, 0x0800, true)
    dir.setUint16(10, 0, true)
    dir.setUint16(12, time, true)
    dir.setUint16(14, day, true)
    dir.setUint32(16, crc, true)
    dir.setUint32(20, data.length, true)
    dir.setUint32(24, data.length, true)
    dir.setUint16(28, name.length, true)
    // Attributs externes : 0x10 = dossier (MS-DOS).
    dir.setUint32(38, entry.path.endsWith('/') ? 0x10 : 0, true)
    dir.setUint32(42, offset, true)
    central.push(new Uint8Array(dir.buffer), name)

    offset += 30 + name.length + data.length
  }

  const centralSize = central.reduce((n, p) => n + p.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, entries.length, true)
  end.setUint16(10, entries.length, true)
  end.setUint32(12, centralSize, true)
  end.setUint32(16, offset, true)
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)] as BlobPart[], { type: 'application/zip' })
}
