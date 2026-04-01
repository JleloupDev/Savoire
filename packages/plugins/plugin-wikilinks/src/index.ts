// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { VaultPlugin, PluginAPI } from '@savoire/plugin-api'

// plugin-wikilinks: transforms [[Page Name]] links into navigable anchors.
// Negative lookbehind for "!" so that ![[...]] embeds (handled by plugin-note-embed) are not touched.
const WIKILINK_RE = /(?<!!)(\[\[([^\]]+)\]\])/g

const plugin: VaultPlugin = {
  manifest: {
    id: 'plugin-wikilinks',
    name: 'Wiki Links',
    version: '0.0.1',
    permissions: ['ui:editor', 'vault:read'],
    defaultActive: true,
  },

  async onload(api: PluginAPI) {
    api.triggers.register({ id: 'wikilinks', character: '[[', description: 'Lien wiki [[Page]]' })

    api.hooks.beforeParse((source) => {
      // Replace [[Target]] with a standard markdown link for now.
      // The full implementation would resolve vault paths.
      // _outer = [[Target]], target = Target (inner capture group)
      return source.replace(WIKILINK_RE, (_m, _outer, target: string) => `[${target}](#${target})`)
    })
  },

  async onunload() {},
}

export default plugin
