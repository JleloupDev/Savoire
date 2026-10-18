// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Archive .zip de l'export d'un vault (navigateur) : relue ici par son
// repertoire central, comme le ferait un outil de decompression.
import { describe, it, expect } from 'vitest'
import { createZip } from '../../../../../apps/web/src/zipArchive'

interface ReadEntry { name: string; data: Uint8Array; crc: number }

function readZip(buf: Uint8Array): ReadEntry[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const end = buf.length - 22
  expect(view.getUint32(end, true)).toBe(0x06054b50)
  const count = view.getUint16(end + 10, true)
  let at = view.getUint32(end + 16, true)
  const out: ReadEntry[] = []
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50)
    const crc = view.getUint32(at + 16, true)
    const size = view.getUint32(at + 20, true)
    const nameLen = view.getUint16(at + 28, true)
    const local = view.getUint32(at + 42, true)
    const name = new TextDecoder().decode(buf.subarray(at + 46, at + 46 + nameLen))
    expect(view.getUint32(local, true)).toBe(0x04034b50)
    const localNameLen = view.getUint16(local + 26, true)
    const start = local + 30 + localNameLen
    out.push({ name, crc, data: buf.slice(start, start + size) })
    at += 46 + nameLen
  }
  return out
}

describe('createZip', () => {
  it('range fichiers et dossiers vides, noms en UTF-8, contenu intact', async () => {
    const blob = createZip([
      { path: 'Vide/' },
      { path: 'Été/Note.md', bytes: new TextEncoder().encode('# Bonjour\n') },
      { path: 'img.png', bytes: new Uint8Array([137, 80, 78, 71, 0, 255]) },
    ])
    expect(blob.type).toBe('application/zip')
    const entries = readZip(new Uint8Array(await blob.arrayBuffer()))
    expect(entries.map(e => e.name)).toEqual(['Vide/', 'Été/Note.md', 'img.png'])
    expect(new TextDecoder().decode(entries[1].data)).toBe('# Bonjour\n')
    expect([...entries[2].data]).toEqual([137, 80, 78, 71, 0, 255])
    // CRC-32 connu de « # Bonjour\n ».
    expect(entries[1].crc).toBe(crc32Reference(new TextEncoder().encode('# Bonjour\n')))
  })

  it('refuse plus d\'entrees que le format classique', () => {
    expect(() => createZip(Array.from({ length: 0x10000 }, (_, i) => ({ path: `${i}` })))).toThrow('archive trop grande')
  })
})

/** CRC-32 bit a bit, independant de l'implementation testee. */
function crc32Reference(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const b of bytes) {
    crc ^= b
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}
