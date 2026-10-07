// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// plugin-wtf — plugin de TEST du runtime de plugins.
//
// Declare un type de fichier .wtf qui n'est que du Markdown. Il ne fournit pas
// de vue : sans open(), l'editeur Markdown de Savoire s'en charge (contrat de
// FileTypeSpec). Il sert a verifier, avec un plugin minimal, que le store
// active et desactive un type de fichier sans jamais en perdre le contenu.

import type { VaultPlugin, PluginAPI } from '@savoire/plugin-api'

const plugin: VaultPlugin = {
  manifest: {
    id: 'plugin-wtf',
    name: 'WTF (test)',
    version: '0.0.1',
    description: 'Plugin de test : des fichiers .wtf qui sont du simple Markdown',
    scope: 'vault',
    permissions: ['ui:editor'],
    defaultActive: true,
  },

  async onload(api: PluginAPI) {
    api.files.register({
      extension: 'wtf',
      label: 'Note WTF',
      icon: '🤪',
      // Le texte EST un CRDT, comme une note Markdown : edition simultanee.
      collaborationMode: 'crdt',
      create: async () => '',
      // Pas d'open() : l'editeur Markdown ouvre le fichier.
    })
  },

  async onunload() {},
}

export default plugin
