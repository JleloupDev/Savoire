// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Archive .zip minimale, sans compression (methode « stored ») : de quoi
// exporter un vault depuis le navigateur sans dependance. Les images sont deja
// compressees ; les notes sont petites. Noms en UTF-8 (drapeau 0x0800).
//
// Limites du format zip classique (sans zip64) : 65 535 entrees, 4 Gio.

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
