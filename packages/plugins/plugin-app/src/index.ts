// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// plugin-app — « Applications » : un logiciel entier dans le vault. Un fichier
// .app (HTML) et son dossier : modules JavaScript, styles, donnees JSON,
// images. L'application tourne dans un cadre isole (frame.ts), sans reseau,
// avec React fourni par Savoire, et lit et ecrit les fichiers de son dossier
// (host.ts). Elle s'ouvre en plein cadre ou en plein ecran.
//
// Le plugin donne aussi un editeur aux fichiers de code et de donnees
// (.json, .geojson, .js, .mjs, .css) : des textes partages, edites a
// plusieurs, que l'IA modifie comme une note.
import type { FileContext, PluginAPI, VaultPlugin } from '@savoire/plugin-api'
import { appAgentTools } from './agentTools'
import { createCodeFileView } from './codeView'
import { APP_MANIFEST } from './manifest'
import { createAppView } from './view'

export { AppHost, MAX_APP_MESSAGE, MAX_APP_CODE, MAX_FILE_WRITES_PER_MINUTE } from './host'
export type { AppHostOptions, AppFileEntry } from './host'
export { buildAppDocument, rewriteAppHtml, APP_CSP, setAppFrameUrl, getAppFrameUrl } from './frame'
export { normalizeAppPath, appFolderOf, rewriteModuleImports, relPathOf, vaultPathOf } from './paths'
export { loadAppLibraries, setAppLibrariesBase, APP_LIBRARY_FILES } from './libs'
export { appAgentTools, appPathOf } from './agentTools'
export { APP_GUIDE } from './guide'
export { APP_TEMPLATE } from './template'
export { APP_MANIFEST } from './manifest'

/** Fichiers de code et de donnees : extension -> libelle. */
export const CODE_FILE_TYPES: { extension: string; label: string; creatable: boolean }[] = [
  { extension: 'json', label: 'Données JSON', creatable: true },
  { extension: 'geojson', label: 'GeoJSON', creatable: false },
  { extension: 'js', label: 'JavaScript', creatable: true },
  { extension: 'mjs', label: 'Module JavaScript', creatable: false },
  { extension: 'css', label: 'Feuille de style', creatable: true },
]

export function createAppPlugin(): VaultPlugin {
  let api: PluginAPI | undefined
  const unregister: (() => void)[] = []
  return {
    manifest: APP_MANIFEST,
    async onload(pluginApi: PluginAPI) {
      api = pluginApi
      pluginApi.files.register({
        extension: 'app',
        label: 'Application',
        icon: 'layout-dashboard',
        // Le code est un texte partage : edition a plusieurs, sans verrou.
        collaborationMode: 'crdt',
        creatable: true,
        create: async () => '',
        open: (path: string, ctx: FileContext) => createAppView(path, ctx, api),
      })
      for (const t of CODE_FILE_TYPES) {
        pluginApi.files.register({
          extension: t.extension,
          label: t.label,
          icon: 'file-code',
          collaborationMode: 'crdt',
          superType: 'text',
          creatable: t.creatable,
          create: async () => (t.extension === 'json' ? '{}\n' : ''),
          open: (path: string, ctx: FileContext) => createCodeFileView(path, ctx),
        })
      }
      for (const tool of appAgentTools(pluginApi)) {
        const off = pluginApi.agents?.registerTool(tool)
        if (off) unregister.push(off)
      }
    },
    async onunload() {
      api?.files.unregister('app')
      for (const t of CODE_FILE_TYPES) api?.files.unregister(t.extension)
      for (const off of unregister.splice(0)) off()
      api = undefined
    },
  }
}

const plugin = createAppPlugin()
export default plugin
