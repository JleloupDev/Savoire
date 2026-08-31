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
  groupId?: string
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
      // ── Autocompletion des references [[...]] ────────────────────────────
      //
      // Le trigger etait declare sans handler : il reservait la sequence « [[ »
      // sans jamais rien proposer. getItems() est SYNCHRONE, alors que
      // vault.list() est asynchrone — d'ou ce cache, rafraichi au chargement
      // puis a chaque changement du vault (creation, renommage, suppression).
      // Tous les hotes ne fournissent pas la surface complete : la page de
      // partage, par exemple, monte un editeur avec un vault reduit. Sans
      // liste, l'autocompletion se tait au lieu de casser le chargement.
      let notePaths: string[] = []
      const refreshNotes = async (): Promise<void> => {
        try {
          notePaths = (await api.vault?.list?.() ?? []).filter(p => !p.endsWith('/'))
        } catch (err) {
          console.warn('[wikilinks] liste du vault indisponible', err)
          notePaths = []
        }
      }
      void refreshNotes()
      api.workspace?.subscribeVaultChange?.(() => void refreshNotes())

      const stemOf = (path: string): string => {
        const base = path.split('/').at(-1) ?? path
        return base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base
      }

      api.triggers.register({
        id: 'wikilinks',
        character: '[[',
        description: 'Lien wiki [[Page]]',
        handler: {
          getItems(query: string) {
            const q = query.trim().toLowerCase()
            const scored = notePaths
              .map(path => ({ path, stem: stemOf(path) }))
              .filter(({ path, stem }) =>
                !q || stem.toLowerCase().includes(q) || path.toLowerCase().includes(q))
              .sort((a, b) => {
                // Une correspondance en debut de nom passe avant une au milieu.
                const ap = a.stem.toLowerCase().startsWith(q) ? 0 : 1
                const bp = b.stem.toLowerCase().startsWith(q) ? 0 : 1
                return ap - bp || a.stem.localeCompare(b.stem)
              })
              .slice(0, 20)

            const items = scored.map(({ path, stem }) => ({
              id: `wikilink:${path}`,
              label: stem,
              description: path,
              icon: '[[',
              category: 'Notes',
              // commitTriggerInsert() remplace « [[ » ET la requete saisie :
              // l'insertion doit donc porter le lien complet.
              insert: `[[${stem}]]`,
            }))

            // Rien ne correspond mais l'utilisateur a tape quelque chose :
            // lui proposer de creer le lien tel quel plutot que de bloquer.
            if (items.length === 0 && q) {
              const raw = query.trim()
              items.push({
                id: `wikilink:new:${raw}`,
                label: raw,
                description: 'Nouvelle note (le lien pointera vers une note a creer)',
                icon: '[[',
                category: 'Nouveau',
                insert: `[[${raw}]]`,
              })
            }
            return items
          },
        },
      })

      api.hooks.beforeParse((source) => {
        return source.replace(
          WIKILINK_RE,
          (_m, _outer, page: string, heading: string | undefined, alias: string | undefined) =>
            toMarkdownLink(page, heading, alias)
        )
      })

      const wikilinkContributor = new WikilinkIndexContributor()
      api.index?.registerFactory(() => wikilinkContributor)
      api.index?.registerFactory(() => new HeadingIndexContributor())

      api.views.register({
        id: 'backlinks',
        title: 'Backlinks',
        icon: 'link',
        groupId: options.groupId,
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
