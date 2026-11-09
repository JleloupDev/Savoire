// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Extracteur d'images : dimensions, et pour une photo JPEG la date de prise
// de vue et l'appareil (EXIF). Lu dans les octets, sans bibliotheque.
// Le texte DANS l'image (OCR) demanderait une bibliotheque : pas ici.
import type { ExtractedContent, PropertyValue } from '@savoire/plugin-api'

export interface ImageInfo {
  format: string
  width?: number
  height?: number
  taken?: string
  camera?: string
}

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n))

/** EXIF (bloc TIFF) : appareil et date de prise de vue. */
function readExif(b: Uint8Array, start: number, end: number): Pick<ImageInfo, 'taken' | 'camera'> {
  const view = new DataView(b.buffer, b.byteOffset + start, end - start)
  const little = ascii(b, start, 2) === 'II'
  const u16 = (o: number) => view.getUint16(o, little)
  const u32 = (o: number) => view.getUint32(o, little)
  const str = (o: number, n: number) => ascii(b, start + o, Math.max(0, n - 1)).replace(/\0+$/, '').trim()
  const tags = new Map<number, string>()
  let exifIfd = 0
  const readIfd = (off: number) => {
    if (off <= 0 || off + 2 > view.byteLength) return
    const n = u16(off)
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12
      if (e + 12 > view.byteLength) return
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4)
      if (tag === 0x8769) { exifIfd = u32(e + 8); continue }
      if (type !== 2) continue
      const at = count > 4 ? u32(e + 8) : e + 8
      if (at + count <= view.byteLength) tags.set(tag, str(at, count))
    }
  }
  try {
    readIfd(u32(4))
    if (exifIfd) readIfd(exifIfd)
  } catch { /* EXIF abime : on garde ce qui a ete lu */ }
  const date = tags.get(0x9003) ?? tags.get(0x0132)
  const make = tags.get(0x010f) ?? ''
  const model = tags.get(0x0110) ?? ''
  const camera = model.startsWith(make) ? model : `${make} ${model}`.trim()
  const m = date ? /^(\d{4}):(\d{2}):(\d{2})/.exec(date) : null
  return { ...(m ? { taken: `${m[1]}-${m[2]}-${m[3]}` } : {}), ...(camera ? { camera } : {}) }
}

export function imageInfo(b: Uint8Array): ImageInfo | null {
  if (b.length < 12) return null
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  if (b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') return { format: 'PNG', width: dv.getUint32(16), height: dv.getUint32(20) }
  if (ascii(b, 0, 3) === 'GIF') return { format: 'GIF', width: dv.getUint16(6, true), height: dv.getUint16(8, true) }
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
    const kind = ascii(b, 12, 4)
    if (kind === 'VP8X') return { format: 'WebP', width: 1 + (b[24] | b[25] << 8 | b[26] << 16), height: 1 + (b[27] | b[28] << 8 | b[29] << 16) }
    if (kind === 'VP8 ') return { format: 'WebP', width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff }
    if (kind === 'VP8L') { const v = dv.getUint32(21, true); return { format: 'WebP', width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 } }
    return { format: 'WebP' }
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    const info: ImageInfo = { format: 'JPEG' }
    let i = 2
    while (i + 4 <= b.length) {
      if (b[i] !== 0xff) { i++; continue }
      const marker = b[i + 1]
      const len = dv.getUint16(i + 2)
      if (marker === 0xe1 && ascii(b, i + 4, 4) === 'Exif') Object.assign(info, readExif(b, i + 10, Math.min(b.length, i + 2 + len)))
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        info.height = dv.getUint16(i + 5)
        info.width = dv.getUint16(i + 7)
        break
      }
      if (marker === 0xda) break
      i += 2 + len
    }
    return info
  }
  if (/<svg[\s>]/.test(new TextDecoder().decode(b.subarray(0, 2048)))) return { format: 'SVG' }
  return null
}

export async function extractImage(bytes: Uint8Array): Promise<ExtractedContent> {
  const info = imageInfo(bytes)
  if (!info) throw new Error('Image illisible.')
  const props: Record<string, PropertyValue> = { format: info.format }
  if (info.width) props.largeur = info.width
  if (info.height) props.hauteur = info.height
  if (info.taken) props.prise_le = info.taken
  if (info.camera) props.appareil = info.camera
  const size = info.width && info.height ? `${info.width} × ${info.height}` : ''
  return { sections: [{ text: [`Image ${info.format}`, size, info.camera, info.taken].filter(Boolean).join(' · ') }], props }
}
