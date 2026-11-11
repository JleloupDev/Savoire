// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Lecture minimale de XML pour les extracteurs des plugins de documents : sans DOMParser (l'index
// tourne aussi hors navigateur), par expressions regulieres sur des formats
// connus (Office Open XML, OpenDocument). Pas un analyseur XML general.

import { readZip } from './archive'
import type { PropertyValue } from './properties'

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', agrave: 'à', acirc: 'â', ccedil: 'ç', ocirc: 'ô', ucirc: 'û',
  ugrave: 'ù', icirc: 'î', iuml: 'ï', Eacute: 'É', Agrave: 'À', laquo: '«', raquo: '»', hellip: '…', rsquo: '’',
  lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', euro: '€', copy: '©', reg: '®', deg: '°',
}

/** Decode les entites XML/HTML courantes et numeriques. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e] ?? ENTITIES[e.toLowerCase()] ?? m
  })
}

/** Les elements <tag ...>…</tag> (le contenu brut de chacun), dans l'ordre. */
export function elements(xml: string, tag: string): { attrs: string; inner: string }[] {
  const out: { attrs: string; inner: string }[] = []
  const name = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`<${name}(\\s[^>]*)?(?:/>|>([\\s\\S]*?)</${name}>)`, 'g')
  for (const m of xml.matchAll(re)) out.push({ attrs: m[1] ?? '', inner: m[2] ?? '' })
  return out
}

/** Valeur d'un attribut (avec ou sans prefixe d'espace de noms). */
export function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name.replace(/[:.]/g, '\\$&')}="([^"]*)"`).exec(attrs)
  return m ? decodeEntities(m[1]) : undefined
}

/** Texte d'un element : le contenu des balises de texte donnees, mis bout a bout. */
export function textOf(xml: string, textTags: string[]): string {
  const names = textTags.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const re = new RegExp(`<(${names})(?:\\s[^>]*)?>([\\s\\S]*?)</\\1>`, 'g')
  let out = ''
  for (const m of xml.matchAll(re)) out += decodeEntities(m[2].replace(/<[^>]+>/g, ''))
  return out
}

/** Premier contenu texte d'une balise (metadonnees : dc:title...). */
export function firstText(xml: string, tag: string): string | undefined {
  const e = elements(xml, tag)[0]
  const t = e ? decodeEntities(e.inner.replace(/<[^>]+>/g, '')).trim() : ''
  return t || undefined
}

// ── Archives de XML (Office Open XML, OpenDocument) ────────────────────────


/** Les fichiers XML d'une archive (.docx, .xlsx, .odt...), par chemin. */
export async function openXmlArchive(bytes: Uint8Array): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  const dec = new TextDecoder('utf-8')
  let entries
  try { entries = await readZip(bytes, 3) } catch { throw new Error('Fichier abîmé ou chiffré : ce n’est pas une archive lisible.') }
  for (const f of entries) if (/\.(xml|rels)$/i.test(f.path)) files.set(f.path, dec.decode(f.bytes))
  return files
}

/** Metadonnees d'un document Office (docProps/core.xml) : titre, auteur, dates, sujet. */
export function officeCoreProps(files: Map<string, string>): { title?: string; props: Record<string, PropertyValue> } {
  const core = files.get('docProps/core.xml') ?? ''
  const props: Record<string, PropertyValue> = {}
  const author = firstText(core, 'dc:creator')
  const created = firstText(core, 'dcterms:created')
  const modified = firstText(core, 'dcterms:modified')
  const subject = firstText(core, 'dc:subject')
  if (author) props.auteur = author
  if (created) props.cree_le = created.slice(0, 10)
  if (modified) props.modifie_le = modified.slice(0, 10)
  if (subject) props.sujet = subject
  return { title: firstText(core, 'dc:title'), props }
}
