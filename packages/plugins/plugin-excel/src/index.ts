// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// plugin-excel — lire les classeurs Excel (.xlsx) : une section par feuille,
// en tableau. Desactiver ce plugin retire leur indexation.
import type { ExtractorSpec, PluginAPI, VaultPlugin } from '@savoire/plugin-api'
import { attr, decodeEntities, elements, firstText, officeCoreProps, openXmlArchive, textOf, type ExtractedContent, type ExtractedSection } from '@savoire/plugin-api'

/** Lignes au plus par feuille. */
export const MAX_ROWS = 2000

/** « B3 » -> colonne 1 (a partir de 0). */
function columnOf(ref: string): number {
  let n = 0
  for (const c of /^[A-Z]+/.exec(ref)?.[0] ?? 'A') n = n * 26 + (c.charCodeAt(0) - 64)
  return n - 1
}

export async function extractXlsx(bytes: Uint8Array): Promise<ExtractedContent> {
  const files = await openXmlArchive(bytes)
  const meta = officeCoreProps(files)
  const shared = elements(files.get('xl/sharedStrings.xml') ?? '', 'si').map(si => textOf(si.inner, ['t']))
  const rels = new Map(elements(files.get('xl/_rels/workbook.xml.rels') ?? '', 'Relationship')
    .map(r => [attr(r.attrs, 'Id') ?? '', (attr(r.attrs, 'Target') ?? '').replace(/^\/?xl\//, '')]))
  const sheets = elements(files.get('xl/workbook.xml') ?? '', 'sheet').map(s => ({
    name: attr(s.attrs, 'name') ?? 'Feuille',
    path: `xl/${rels.get(attr(s.attrs, 'r:id') ?? '') ?? ''}`,
  }))
  const sections: ExtractedSection[] = []
  for (const sheet of sheets) {
    const xml = files.get(sheet.path)
    if (!xml) continue
    const rows: string[][] = []
    for (const row of elements(xml, 'row').slice(0, MAX_ROWS)) {
      const cells: string[] = []
      for (const c of elements(row.inner, 'c')) {
        const type = attr(c.attrs, 't')
        const col = columnOf(attr(c.attrs, 'r') ?? 'A')
        const v = firstText(c.inner, 'v')
        const value = type === 's' ? shared[Number(v)] ?? ''
          : type === 'inlineStr' ? textOf(c.inner, ['t'])
          : type === 'b' ? (v === '1' ? 'VRAI' : 'FAUX')
          : decodeEntities(v ?? '')
        while (cells.length < col) cells.push('')
        cells[col] = value
      }
      if (cells.some(x => x)) rows.push(cells)
    }
    sections.push({ heading: sheet.name, text: rows.map(r => r.join('\t')).join('\n'), rows })
  }
  return { title: meta.title, sections, props: { ...meta.props, feuilles: sheets.length } }
}

export const EXTRACTOR: ExtractorSpec = { id: 'xlsx', label: 'Classeurs Excel', extensions: ['xlsx'], version: 1, extract: b => extractXlsx(b) }

let unregister: (() => void) | null = null

const plugin: VaultPlugin = {
  manifest: {
    id: 'plugin-excel',
    name: 'Classeurs Excel',
    version: '0.0.1',
    description: 'Le contenu des classeurs Excel (.xlsx) dans la recherche, et leur aperçu en tableaux',
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
