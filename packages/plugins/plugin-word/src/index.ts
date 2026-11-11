// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// plugin-word — lire les documents Word (.docx). Le texte et les titres
// vont dans l'index ; l'apercu en lecture seule s'affiche a l'ouverture (le
// plugin Office tient le type de fichier). Desactiver ce plugin retire
// l'indexation des documents Word.
import type { ExtractorSpec, PluginAPI, VaultPlugin } from '@savoire/plugin-api'
import { elements, officeCoreProps, openXmlArchive, textOf, type ExtractedContent, type ExtractedSection } from '@savoire/plugin-api'

/** Style de titre d'un paragraphe Word (Heading1, Titre1, Title...). */
function headingLevel(pPr: string): number | null {
  const style = /<w:pStyle\s+w:val="([^"]+)"/.exec(pPr)?.[1] ?? ''
  if (/^(Title|Titre)$/i.test(style)) return 0
  const m = /^(?:Heading|Titre|berschrift|Kop)(\d)$/i.exec(style)
  return m ? Number(m[1]) : null
}

export async function extractDocx(bytes: Uint8Array): Promise<ExtractedContent> {
  const files = await openXmlArchive(bytes)
  const doc = files.get('word/document.xml')
  if (!doc) throw new Error('Document Word sans contenu (word/document.xml absent).')
  const meta = officeCoreProps(files)
  const sections: ExtractedSection[] = [{ text: '' }]
  let title = meta.title
  for (const p of elements(doc, 'w:p')) {
    const inner = p.inner.replace(/<w:tab\/>/g, '<w:t>\t</w:t>').replace(/<w:br\/>/g, '<w:t>\n</w:t>')
    const text = textOf(inner, ['w:t']).trim()
    if (!text) continue
    const level = headingLevel(/<w:pPr>[\s\S]*?<\/w:pPr>/.exec(inner)?.[0] ?? '')
    if (level === 0 && !title) { title = text; continue }
    if (level !== null && level > 0) { sections.push({ heading: text, text: '' }); continue }
    const s = sections[sections.length - 1]
    s.text += (s.text ? '\n' : '') + text
  }
  return { title, sections: sections.filter(s => s.heading || s.text), props: meta.props }
}

export const EXTRACTOR: ExtractorSpec = { official: true, id: 'docx', label: 'Documents Word', extensions: ['docx'], version: 1, extract: b => extractDocx(b) }

let unregister: (() => void) | null = null

const plugin: VaultPlugin = {
  manifest: {
    id: 'plugin-word',
    name: 'Documents Word',
    version: '0.0.1',
    description: 'Le texte des documents Word (.docx) dans la recherche, et leur aperçu',
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
