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
