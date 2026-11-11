// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// plugin-opendocument — lire les documents LibreOffice : texte, classeur,
// presentation. Desactiver ce plugin retire leur indexation.
import type { ExtractorSpec, PluginAPI, VaultPlugin } from '@savoire/plugin-api'
import { attr, decodeEntities, elements, firstText, openXmlArchive, type ExtractedContent, type ExtractedSection, type PropertyValue } from '@savoire/plugin-api'

/** Lignes au plus par feuille. */
const MAX_ROWS = 2000

export async function extractOpenDocument(bytes: Uint8Array): Promise<ExtractedContent> {
  const files = await openXmlArchive(bytes)
  const content = files.get('content.xml')
  if (!content) throw new Error('Document OpenDocument sans contenu (content.xml absent).')
  const meta = files.get('meta.xml') ?? ''
  const props: Record<string, PropertyValue> = {}
  const author = firstText(meta, 'meta:initial-creator') ?? firstText(meta, 'dc:creator')
  const created = firstText(meta, 'meta:creation-date')
  if (author) props.auteur = author
  if (created) props.cree_le = created.slice(0, 10)
  const title = firstText(meta, 'dc:title')
  const body = /<office:body>([\s\S]*)<\/office:body>/.exec(content)?.[1] ?? content
  const sections: ExtractedSection[] = []

  // Classeur : une section par feuille, en tableau.
  const tables = elements(body, 'table:table')
  if (/<office:spreadsheet>/.test(body)) {
    for (const t of tables) {
      const rows = elements(t.inner, 'table:table-row').slice(0, MAX_ROWS).map(r =>
        elements(r.inner, 'table:table-cell').map(c => elements(c.inner, 'text:p').map(p => decodeEntities(p.inner.replace(/<[^>]+>/g, ''))).join(' ')),
      ).filter(r => r.some(x => x))
      sections.push({ heading: attr(t.attrs, 'table:name') ?? 'Feuille', text: rows.map(r => r.join('\t')).join('\n'), rows })
    }
    return { title, sections, props }
  }
  // Presentation : une section par page.
  if (/<office:presentation>/.test(body)) {
    elements(body, 'draw:page').forEach((page, i) => {
      const lines = elements(page.inner, 'text:p').map(p => decodeEntities(p.inner.replace(/<[^>]+>/g, '')).trim()).filter(Boolean)
      sections.push({ heading: `Diapositive ${i + 1}${lines[0] ? ` : ${lines[0]}` : ''}`, text: lines.slice(1).join('\n') })
    })
    return { title, sections, props }
  }
  // Texte : titres (text:h) et paragraphes (text:p), dans l'ordre.
  sections.push({ text: '' })
  for (const m of body.matchAll(/<text:(h|p)(\s[^>]*)?>([\s\S]*?)<\/text:\1>/g)) {
    const text = decodeEntities(m[3].replace(/<text:tab\/>/g, '\t').replace(/<text:line-break\/>/g, '\n').replace(/<[^>]+>/g, '')).trim()
    if (!text) continue
    if (m[1] === 'h') sections.push({ heading: text, text: '' })
    else {
      const s = sections[sections.length - 1]
      s.text += (s.text ? '\n' : '') + text
    }
  }
  return { title, sections: sections.filter(s => s.heading || s.text), props }
}

export const EXTRACTOR: ExtractorSpec = { official: true, id: 'opendocument', label: 'Documents LibreOffice', extensions: ['odt', 'ods', 'odp'], version: 1, extract: b => extractOpenDocument(b) }

let unregister: (() => void) | null = null

const plugin: VaultPlugin = {
  manifest: {
    id: 'plugin-opendocument',
    name: 'Documents LibreOffice',
    version: '0.0.1',
    description: 'Le contenu des documents LibreOffice (.odt, .ods, .odp) dans la recherche, et leur aperçu',
    scope: 'vault',
    permissions: ['ui:editor', 'vault:read'],
    defaultActive: true,
    // Verifie par l'equipe Savoire : peut tourner sur le pair indexeur du serveur.
    official: true,
  },
  async onload(api: PluginAPI) {
    unregister = api.extractors?.register(EXTRACTOR) ?? null
  },
  async onunload() {
    unregister?.()
    unregister = null
  },
}

export default plugin
