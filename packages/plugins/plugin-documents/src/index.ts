// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// plugin-documents — lire les documents que Savoire n'edite pas.
//
// Une base documentaire existante (Word, PowerPoint, Excel, LibreOffice,
// pages web, CSV, images, PDF) entre dans le vault telle quelle :
//  - des EXTRACTEURS (api.extractors) en tirent le texte et des proprietes :
//    l'index les cherche et les interroge comme des notes ;
//  - un APERCU en lecture seule s'affiche quand on ouvre le fichier.
// Rien n'est modifie : ces documents ne sont pas des CRDT, ils restent en
// lecture seule dans Savoire.
import { extensionOfPath, type ExtractorSpec, type FileContext, type FileView, type PluginAPI, type VaultPlugin } from '@savoire/plugin-api'
import { extractDocx, extractOpenDocument, extractPptx, extractXlsx } from './office'
import { extractCsv, extractHtml, extractText } from './text'
import { extractImage } from './images'
import { ensureStyle, genericPreview, htmlPreview, nativePreview } from './preview'

export { extractDocx, extractPptx, extractXlsx, extractOpenDocument } from './office'
export { extractCsv, extractHtml, extractText, parseDelimited } from './text'
export { extractImage, imageInfo } from './images'
export { genericPreview } from './preview'

export const EXTRACTORS: ExtractorSpec[] = [
  { id: 'docx', label: 'Documents Word', extensions: ['docx'], version: 1, extract: b => extractDocx(b) },
  { id: 'pptx', label: 'Présentations PowerPoint', extensions: ['pptx'], version: 1, extract: b => extractPptx(b) },
  { id: 'xlsx', label: 'Classeurs Excel', extensions: ['xlsx'], version: 1, extract: b => extractXlsx(b) },
  { id: 'opendocument', label: 'Documents LibreOffice', extensions: ['odt', 'ods', 'odp'], version: 1, extract: b => extractOpenDocument(b) },
  { id: 'html', label: 'Pages web', extensions: ['html', 'htm'], version: 1, extract: b => extractHtml(b), preview: b => htmlPreview(b) },
  { id: 'text', label: 'Texte brut', extensions: ['txt', 'log'], version: 1, extract: b => extractText(b) },
  { id: 'csv', label: 'Tableaux CSV', extensions: ['csv', 'tsv'], version: 1, extract: b => extractCsv(b) },
  {
    id: 'images', label: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'], version: 1,
    extract: b => extractImage(b), preview: (b, info) => nativePreview(b, extensionOfPath(info.path)),
  },
  // Le texte d'un PDF demanderait une bibliotheque (pdf.js) : apercu seulement.
  { id: 'pdf', label: 'PDF', extensions: ['pdf'], version: 1, extract: async () => ({ sections: [] }), preview: b => nativePreview(b, 'pdf') },
]

/** Types sans autre plugin : ce plugin les ouvre en apercu. (Office : le plugin Office.) */
const FILE_TYPES = [
  { extension: 'pdf', label: 'PDF', icon: 'file-text', superType: 'binary' as const },
  { extension: 'html', label: 'Page web', icon: 'globe' },
  { extension: 'htm', label: 'Page web', icon: 'globe' },
  { extension: 'csv', label: 'Tableau CSV', icon: 'sheet' },
]

/** Apercu en lecture seule d'un fichier, par son extracteur. */
export async function renderPreview(api: Pick<PluginAPI, 'extractors'> | null, path: string, bytes: Uint8Array): Promise<HTMLElement> {
  const spec = api?.extractors?.forPath(path) ?? EXTRACTORS.find(e => e.extensions.includes(extensionOfPath(path)))
  if (!spec) throw new Error('Aucun aperçu pour ce type de fichier.')
  if (spec.preview) return spec.preview(bytes, { path })
  return genericPreview(await spec.extract(bytes, { path }))
}

/** Vue en lecture seule : un bandeau, puis l'apercu. */
export function createPreviewView(path: string, ctx: FileContext, api: PluginAPI | null): FileView {
  let dead = false
  return {
    mount(container: HTMLElement) {
      ensureStyle()
      container.replaceChildren()
      container.style.cssText = 'height:100%;display:flex;flex-direction:column;overflow:hidden'
      const banner = document.createElement('div')
      banner.className = 'doc-banner'
      banner.dataset.testid = 'document-banner'
      banner.textContent = 'Aperçu en lecture seule : ce document se modifie dans son logiciel.'
      const body = document.createElement('div')
      body.dataset.testid = 'document-preview'
      body.style.cssText = 'flex:1;min-height:0;overflow:auto'
      container.append(banner, body)
      void (async () => {
        const bytes = await ctx.vault?.readBinary?.(path)
        if (dead) return
        if (!bytes) { body.textContent = 'Aperçu indisponible : les octets de ce fichier ne sont pas sur ce poste.'; return }
        body.replaceChildren(await renderPreview(api, path, bytes))
      })().catch(err => { if (!dead) body.textContent = `Aperçu impossible : ${err instanceof Error ? err.message : String(err)}` })
    },
    destroy() { dead = true },
  }
}

let pluginAPI: PluginAPI | null = null
const unregister: (() => void)[] = []

const plugin: VaultPlugin = {
  manifest: {
    id: 'plugin-documents',
    name: 'Documents existants',
    version: '0.0.1',
    description: 'Word, PowerPoint, Excel, LibreOffice, pages web, CSV, images, PDF : texte dans la recherche, aperçu en lecture seule',
    scope: 'vault',
    permissions: ['ui:editor', 'vault:read'],
    defaultActive: true,
  },
  async onload(api: PluginAPI) {
    pluginAPI = api
    for (const spec of EXTRACTORS) if (api.extractors) unregister.push(api.extractors.register(spec))
    for (const t of FILE_TYPES) {
      api.files.register({
        ...t,
        collaborationMode: 'none',
        creatable: false,
        create: async () => '',
        open: (path: string, ctx: FileContext) => createPreviewView(path, ctx, pluginAPI),
      })
    }
  },
  async onunload() {
    for (const u of unregister.splice(0)) u()
    pluginAPI = null
  },
}

export default plugin
