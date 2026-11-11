// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// plugin-powerpoint — lire les presentations PowerPoint (.pptx) : une
// section par diapositive. Desactiver ce plugin retire leur indexation.
import type { ExtractorSpec, PluginAPI, VaultPlugin } from '@savoire/plugin-api'
import { elements, officeCoreProps, openXmlArchive, textOf, type ExtractedContent } from '@savoire/plugin-api'

export async function extractPptx(bytes: Uint8Array): Promise<ExtractedContent> {
  const files = await openXmlArchive(bytes)
  const meta = officeCoreProps(files)
  const slides = [...files.keys()]
    .filter(p => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]))
  const sections = slides.map((path, i) => {
    const lines = elements(files.get(path)!, 'a:p').map(p => textOf(p.inner, ['a:t']).trim()).filter(Boolean)
    // La premiere ligne d'une diapositive est le plus souvent son titre.
    return { heading: `Diapositive ${i + 1}${lines[0] ? ` : ${lines[0]}` : ''}`, text: lines.slice(1).join('\n') }
  })
  return { title: meta.title, sections, props: { ...meta.props, diapositives: slides.length } }
}

export const EXTRACTOR: ExtractorSpec = { id: 'pptx', label: 'Présentations PowerPoint', extensions: ['pptx'], version: 1, extract: b => extractPptx(b) }

let unregister: (() => void) | null = null

const plugin: VaultPlugin = {
  manifest: {
    id: 'plugin-powerpoint',
    name: 'Présentations PowerPoint',
    version: '0.0.1',
    description: 'Le texte des présentations PowerPoint (.pptx) dans la recherche, et leur aperçu',
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
