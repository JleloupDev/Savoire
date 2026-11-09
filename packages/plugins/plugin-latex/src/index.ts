// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// plugin-latex — des documents LaTeX (.tex) ecrits a plusieurs.
//
// Le texte du document est un CRDT (collaborationMode 'crdt') : chaque membre
// tape dans son editeur, sans verrou, et les modifications se rejoignent.
// L'apercu est une traduction en HTML et MathML faite dans la page, sans
// moteur TeX (voir render.ts) : il suit chaque frappe, hors ligne compris.
import type { FileContext, PluginAPI, VaultPlugin } from '@savoire/plugin-api'
import { createLatexView } from './view'
import { LATEX_TEMPLATE } from './template'

export { renderLatex, stripComments } from './render'
export { texToMathML } from './math'
export { bindSharedText, toDelta, toChanges } from './binding'
export { createLatexView, latexEditorOf } from './view'
export { LATEX_TEMPLATE } from './template'

let pluginAPI: PluginAPI | null = null

const plugin: VaultPlugin = {
  manifest: {
    id: 'plugin-latex',
    name: 'LaTeX',
    version: '0.0.1',
    description: 'Des documents LaTeX (.tex) écrits à plusieurs, avec un aperçu des formules',
    scope: 'vault',
    permissions: ['ui:editor', 'vault:read'],
    defaultActive: true,
  },

  async onload(api: PluginAPI) {
    pluginAPI = api
    api.files.register({
      extension: 'tex',
      label: 'Document LaTeX',
      icon: 'sigma',
      collaborationMode: 'crdt',
      creatable: true,
      create: async () => LATEX_TEMPLATE,
      open: (path: string, ctx: FileContext) => createLatexView(path, ctx, pluginAPI),
    })
  },

  async onunload() {
    pluginAPI = null
  },
}

export default plugin
