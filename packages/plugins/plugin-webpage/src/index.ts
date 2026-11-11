// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// plugin-webpage — lire les pages web (.html) : titre, sections par titre,
// description. Apercu dans un cadre sans script.
import { createDocumentPreviewView, type ExtractorSpec, type FileContext, type PluginAPI, type VaultPlugin } from '@savoire/plugin-api'
import { decodeEntities, htmlPreview, type ExtractedContent, type ExtractedSection } from '@savoire/plugin-api'

const decode = (b: Uint8Array) => {
  const t = new TextDecoder('utf-8').decode(b)
  return t.charCodeAt(0) === 0xfeff ? t.slice(1) : t
}

const clean = (html: string) => decodeEntities(html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h\d)>/gi, '\n').replace(/<[^>]+>/g, ''))
  .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim()

export async function extractHtml(bytes: Uint8Array): Promise<ExtractedContent> {
  const html = decode(bytes).replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, '').replace(/<!--[\s\S]*?-->/g, '')
  const title = clean(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '') || undefined
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html
  const sections: ExtractedSection[] = []
  // Une section par titre h1-h3 ; le texte d'avant le premier titre a part.
  const parts = body.split(/(<h[1-3][^>]*>[\s\S]*?<\/h[1-3]>)/i)
  let current: ExtractedSection = { text: '' }
  for (const part of parts) {
    const h = /^<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>$/i.exec(part)
    if (h) { if (current.heading || current.text) sections.push(current); current = { heading: clean(h[1]), text: '' }; continue }
    const t = clean(part)
    if (t) current.text += (current.text ? '\n' : '') + t
  }
  if (current.heading || current.text) sections.push(current)
  const description = /<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i.exec(html)?.[1]
  return { title, sections, ...(description ? { props: { description: decodeEntities(description) } } : {}) }
}

export const EXTRACTOR: ExtractorSpec = { official: true, id: 'html', label: 'Pages web', extensions: ['html', 'htm'], version: 1, extract: b => extractHtml(b), preview: b => htmlPreview(b) }

const FILE_TYPES = [
  { extension: 'html', label: 'Page web', icon: 'globe', superType: 'text' as const },
  { extension: 'htm', label: 'Page web', icon: 'globe', superType: 'text' as const },
]

let unregister: (() => void) | null = null

const plugin: VaultPlugin = {
  manifest: {
    id: 'plugin-webpage',
    name: 'Pages web',
    version: '0.0.1',
    description: 'Les pages web (.html) : leur texte dans la recherche, un aperçu sans script',
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
