// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { VaultPlugin, PluginAPI } from '@savoire/plugin-api'
import { linkTargetFor, noteName, resolveLinkPath } from '@savoire/plugin-api'
import { WikilinkIndexContributor } from './WikilinkIndexContributor'
import { HeadingIndexContributor } from './HeadingIndexContributor'
import { BacklinksWidget } from './BacklinksWidget'
import { allFilePaths } from './vaultFiles'

// [[Page]], [[Page#Heading]], [[Page|Alias]], [[Page#Heading|Alias]]
// Negative lookbehind for "!" so ![[...]] embeds are not touched.
const WIKILINK_RE = /(?<!!)(\[\[([^\]#|]+?)(?:#([^\]|]+?))?(?:\|([^\]]+))?\]\])/g

// Adresse d'un lien rendu : `#Page`, ou `#Page#Titre`, `#Page#^bloc` (la cible
// telle qu'ecrite). Le clic ouvre la note ; le survol en montre l'apercu
// (plugin-note-embed), titre ou bloc compris.
function toMarkdownLink(page: string, heading: string | undefined, alias: string | undefined): string {
  const label = alias ?? (heading ? `${page} > ${heading}` : page)
  const href = heading ? `#${page}#${heading}` : `#${page}`
  // Une adresse avec des espaces (« Genese 8 ») n'est un lien Markdown
  // qu'entre chevrons ; sans eux, le lien s'affichait en texte brut.
  const dest = /[\s()<>]/.test(href) ? `<${href.replace(/[<>]/g, '')}>` : href
  return `[${label}](${dest})`
}

/** La note et le morceau vises par un lien rendu (`#Page`, `#Page#Titre`, `#Page#^bloc`). */
export function linkTargetOf(href: string): { page: string; subpath: string } {
  let raw = href.replace(/^#/, '')
  try { raw = decodeURIComponent(raw) } catch { /* garde tel quel */ }
  const at = raw.indexOf('#')
  return at < 0 ? { page: raw.trim(), subpath: '' } : { page: raw.slice(0, at).trim(), subpath: raw.slice(at + 1) }
}

/** La note visee par un lien rendu. */
export function linkPageOf(href: string): string {
  return linkTargetOf(href).page
}

export function createWikilinksPlugin(options: {
  groupId?: string
  tabOf?: string
  belowOf?: string
  initialSize?: number
} = {}): VaultPlugin {
  let removeListeners: (() => void) | null = null
  return {
    manifest: {
      id: 'plugin-wikilinks',
      scope: 'vault',
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
          notePaths = typeof api.vault?.list === 'function' ? await allFilePaths(api.vault) : []
        } catch (err) {
          console.warn('[wikilinks] liste du vault indisponible', err)
          notePaths = []
        }
      }
      void refreshNotes()
      api.workspace?.subscribeVaultChange?.(() => void refreshNotes())

      const stemOf = noteName

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
              // l'insertion doit donc porter le lien complet. Le nom seul
              // s'il est unique, sinon le chemin (comme Obsidian).
              insert: `[[${linkTargetFor(path, notePaths)}]]`,
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

      // Clic sur un lien rendu dans une note : ouvrir la note visee (comme
      // Obsidian). Avant l'editeur, qui passerait la ligne en edition.
      if (typeof document !== 'undefined') {
        const linkAt = (e: MouseEvent): string | null => {
          if (e.button !== 0) return null
          const a = (e.target as Element | null)?.closest?.('a[href^="#"]')
          if (!a || !(a.closest('.cm-editor') || a.closest('.link-preview'))) return null
          const page = linkPageOf(a.getAttribute('href') ?? '')
          return page ? resolveLinkPath(page, notePaths) ?? null : null
        }
        const onDown = (e: MouseEvent) => {
          const path = linkAt(e)
          if (!path) return
          e.preventDefault()
          e.stopPropagation()
          void api.workspace?.openFile(path)
        }
        const onClick = (e: MouseEvent) => { if (linkAt(e)) e.preventDefault() }
        document.addEventListener('mousedown', onDown, true)
        document.addEventListener('click', onClick, true)
        removeListeners = () => {
          document.removeEventListener('mousedown', onDown, true)
          document.removeEventListener('click', onClick, true)
        }
      }

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
          // Avec un index de tout le vault (api.indexer), les notes jamais ouvertes comptent aussi.
          return new BacklinksWidget(ctx, wikilinkContributor, api.indexer)
        },
      })
    },

    async onunload() {
      removeListeners?.()
      removeListeners = null
    },
  }
}

export { WikilinkIndexContributor } from './WikilinkIndexContributor'
export { HeadingIndexContributor } from './HeadingIndexContributor'
export { BacklinksWidget } from './BacklinksWidget'
