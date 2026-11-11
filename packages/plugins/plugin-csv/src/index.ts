// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// plugin-csv — lire les fichiers CSV et TSV (separateur devine). Apercu en
// tableau.
import { createDocumentPreviewView, type ExtractorSpec, type FileContext, type PluginAPI, type VaultPlugin } from '@savoire/plugin-api'
import type { ExtractedContent } from '@savoire/plugin-api'

/** Lignes au plus. */
const MAX_ROWS = 2000

const decode = (b: Uint8Array) => {
  const t = new TextDecoder('utf-8').decode(b)
  return t.charCodeAt(0) === 0xfeff ? t.slice(1) : t
}

/** Separateur d'un CSV : celui qui revient le plus sur la premiere ligne. */
function separator(line: string): string {
  const counts = [',', ';', '\t'].map(s => [s, line.split(s).length] as const)
  return counts.sort((a, b) => b[1] - a[1])[0][0]
}

export function parseDelimited(text: string, sep: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++ } else if (c === '"') quoted = false
      else field += c
    } else if (c === '"' && field === '') quoted = true
    else if (c === sep) { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''; rows.push(row); row = []
      if (rows.length >= MAX_ROWS) return rows
    } else field += c
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  return rows.filter(r => r.some(x => x !== ''))
}

export async function extractCsv(bytes: Uint8Array): Promise<ExtractedContent> {
  const text = decode(bytes)
  const rows = parseDelimited(text, separator(text.split('\n', 1)[0] ?? ''))
  return {
    sections: [{ text: rows.map(r => r.join('\t')).join('\n'), rows }],
    props: { lignes: Math.max(0, rows.length - 1), colonnes: rows[0]?.length ?? 0 },
  }
}

export const EXTRACTOR: ExtractorSpec = { id: 'csv', label: 'Tableaux CSV', extensions: ['csv', 'tsv'], version: 1, extract: b => extractCsv(b) }

const FILE_TYPES = [
  { extension: 'csv', label: 'Tableau CSV', icon: 'sheet', superType: 'text' as const },
  { extension: 'tsv', label: 'Tableau TSV', icon: 'sheet', superType: 'text' as const },
]

let unregister: (() => void) | null = null

const plugin: VaultPlugin = {
  manifest: {
    id: 'plugin-csv',
    name: 'Tableaux CSV',
    version: '0.0.1',
    description: 'Les fichiers CSV : leur contenu dans la recherche, un aperçu en tableau',
    scope: 'vault',
    permissions: ['ui:editor', 'vault:read'],
    defaultActive: true,
    // Verifie par l'equipe Savoire : peut tourner sur le pair indexeur du serveur.
    official: true,
  },
  async onload(api: PluginAPI) {
    unregister = api.extractors?.register(EXTRACTOR) ?? null
    for (const t of FILE_TYPES) {
      api.files.register({
        ...t,
        collaborationMode: 'none',
        creatable: false,
        create: async () => '',
        open: (path: string, ctx: FileContext) => createDocumentPreviewView(path, ctx, EXTRACTOR),
      })
    }
  },
  async onunload() {
    unregister?.()
    unregister = null
  },
}

export default plugin
