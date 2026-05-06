// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { VaultPlugin, PluginAPI } from '@savoire/plugin-api'
import { WikilinkIndexContributor } from './WikilinkIndexContributor'
import { HeadingIndexContributor, headingToAnchor } from './HeadingIndexContributor'
import { BacklinksWidget } from './BacklinksWidget'

// [[Page]], [[Page#Heading]], [[Page|Alias]], [[Page#Heading|Alias]]
// Negative lookbehind for "!" so ![[...]] embeds are not touched.
const WIKILINK_RE = /(?<!!)(\[\[([^\]#|]+?)(?:#([^\]|]+?))?(?:\|([^\]]+))?\]\])/g

// DECISION: follows Obsidian's wikilink convention — `#Page#heading` is intercepted by the
// editor router to open Page and scroll to the heading. The router is not yet implemented.
function toMarkdownLink(page: string, heading: string | undefined, alias: string | undefined): string {
  const label = alias ?? (heading ? `${page} > ${heading}` : page)
  const href = heading ? `#${page}#${headingToAnchor(heading)}` : `#${page}`
  return `[${label}](${href})`
}

export function createWikilinksPlugin(options: {
  tabOf?: string
  belowOf?: string
  initialSize?: number
} = {}): VaultPlugin {
  return {
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
        return source.replace(
          WIKILINK_RE,
          (_m, _outer, page: string, heading: string | undefined, alias: string | undefined) =>
            toMarkdownLink(page, heading, alias)
        )
      })

      api.index?.registerFactory(() => new WikilinkIndexContributor())
      api.index?.registerFactory(() => new HeadingIndexContributor())

      api.views.register({
        id: 'backlinks',
        title: 'Backlinks',
        icon: 'link',
        container: 'right',
        tabOf: options.tabOf,
        belowOf: options.belowOf,
        initialSize: options.initialSize ?? 280,
        closable: true,
        createView(ctx) {
          return new BacklinksWidget(ctx, wikilinkContributor)
        },
      })
    },

    async onunload() {},
  }
}

export { WikilinkIndexContributor } from './WikilinkIndexContributor'
export { HeadingIndexContributor } from './HeadingIndexContributor'
export { BacklinksWidget } from './BacklinksWidget'
