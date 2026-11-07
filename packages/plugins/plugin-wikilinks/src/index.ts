// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { VaultPlugin, PluginAPI } from '@savoire/plugin-api'
import { linkTargetFor, noteName, resolveLinkPath } from '@savoire/plugin-api'
import { WikilinkIndexContributor } from './WikilinkIndexContributor'
import { HeadingIndexContributor } from './HeadingIndexContributor'
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

/**
 * Chemin libre d'une sous-page de `notePath` : `A/Note.md` ->
 * `A/Note/Nouvelle page.md`, puis `Nouvelle page 2.md`... null sans extension.
 */
export function newPagePath(notePath: string, existing: readonly string[], title = 'Nouvelle page'): string | null {
  const slash = notePath.lastIndexOf('/')
  const name = notePath.slice(slash + 1)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return null
  const folder = `${notePath.slice(0, slash + 1)}${name.slice(0, dot)}/`
  const taken = new Set(existing.map(p => p.toLowerCase()))
  let candidate = `${folder}${title}.md`
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${folder}${title} ${n}.md`
  return candidate
}

/**
 * Chemin de la note a creer pour un lien `[[page]]` sans cible : sous la
 * note courante (newPagePath), ou au chemin ecrit s'il contient un dossier.
 * null : nom vide, ou pas de note courante.
 */
export function pagePathFor(page: string, notePath: string | null, existing: readonly string[]): string | null {
  const clean = page.replace(/[\\:*?"<>|]/g, '').replace(/\.md$/i, '').trim()
  if (!clean || clean.split('/').some(part => !part.trim() || part === '.' || part === '..')) return null
  if (clean.includes('/')) return `${clean}.md`
  return notePath ? newPagePath(notePath, existing, clean) : `${clean}.md`
}

/**
 * Le lien [[...]] ecrit en texte brut sous ce point de l'ecran (une ligne en
 * cours d'edition), ou null.
 */
export function rawLinkAt(x: number, y: number): string | null {
  const doc = document as Document & { caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null }
  let node: Node | null = null
  let offset = 0
  if (typeof doc.caretPositionFromPoint === 'function') {
    const pos = doc.caretPositionFromPoint(x, y)
    if (pos) { node = pos.offsetNode; offset = pos.offset }
  } else if (typeof document.caretRangeFromPoint === 'function') {
    const range = document.caretRangeFromPoint(x, y)
    if (range) { node = range.startContainer; offset = range.startOffset }
  }
  const line = (node instanceof Element ? node : node?.parentElement)?.closest('.cm-line')
  if (!node || !line) return null
  const before = document.createRange()
  before.setStart(line, 0)
  before.setEnd(node, offset)
  return wikilinkAtOffset(line.textContent ?? '', before.toString().length)
}

/** La page du lien [[...]] qui couvre cette position du texte, ou null. */
export function wikilinkAtOffset(text: string, at: number): string | null {
  for (const m of text.matchAll(/(?<!!)\[\[([^\]#|]*?)(?:#[^\]|]*?)?(?:\|[^\]]*)?\]\]/g)) {
    const start = m.index ?? 0
    if (at >= start && at <= start + m[0].length) return m[1].trim() || null
  }
  return null
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

/** Les reglages du panneau des retroliens sont passes a plugin-backlinks : ignores ici. */
export function createWikilinksPlugin(_legacy: { groupId?: string; tabOf?: string; belowOf?: string; initialSize?: number } = {}): VaultPlugin {
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

      // Ouvrir la note visee par un lien, ou la creer si elle n'existe pas
      // encore (comme Obsidian) : rangee sous la note courante, dans son
      // dossier (`A/Note.md` -> `A/Note/Nom.md`), comme ses images.
      const openOrCreate = async (page: string): Promise<void> => {
        const found = resolveLinkPath(page, notePaths)
        if (found) { await api.workspace?.openFile(found); return }
        const path = pagePathFor(page, api.workspace?.getActiveDocument?.()?.path ?? null, notePaths)
        if (!path || typeof api.vault?.createFile !== 'function') return
        try {
          await api.vault.createFile(path)
        } catch (err) {
          console.warn('[wikilinks] page non creee', err)
          return
        }
        notePaths = [...notePaths, path]
        api.workspace?.notifyVaultChange?.()
        await api.workspace?.openFile(path)
      }

      // Clic sur un lien rendu dans une note : ouvrir la note visee (comme
      // Obsidian) ; Ctrl+clic sur un lien sans note la cree. Ctrl+clic (Cmd sur Mac) sur un lien en cours
      // d'ecriture ([[Nom]] en texte brut) fait de meme. Avant l'editeur, qui
      // passerait la ligne en edition.
      if (typeof document !== 'undefined') {
        const linkAt = (e: MouseEvent): string | null => {
          if (e.button !== 0) return null
          const target = e.target as Element | null
          const a = target?.closest?.('a[href^="#"]')
          if (a && (a.closest('.cm-editor') || a.closest('.link-preview'))) {
            const page = linkPageOf(a.getAttribute('href') ?? '')
            // Une note absente ne se cree qu'au Ctrl+clic : pas par megarde.
            if (!page || (!resolveLinkPath(page, notePaths) && !(e.ctrlKey || e.metaKey))) return null
            return page
          }
          if (!(e.ctrlKey || e.metaKey) || !target?.closest?.('.cm-editor')) return null
          return rawLinkAt(e.clientX, e.clientY)
        }
        const onDown = (e: MouseEvent) => {
          const page = linkAt(e)
          if (!page) return
          e.preventDefault()
          e.stopPropagation()
          void openOrCreate(page)
        }
        const onClick = (e: MouseEvent) => { if (linkAt(e)) e.preventDefault() }
        document.addEventListener('mousedown', onDown, true)
        document.addEventListener('click', onClick, true)
        removeListeners = () => {
          document.removeEventListener('mousedown', onDown, true)
          document.removeEventListener('click', onClick, true)
        }
      }

      // « /page » : des crochets [[ ]] ou taper le nom de la page ; Ctrl+clic
      // sur le lien la cree, rangee sous la note courante.
      api.slash?.register({
        id: 'wikilinks:new-page',
        label: 'Page',
        description: 'Lien vers une nouvelle note : tapez son nom, Ctrl+clic la crée',
        icon: '📄',
        category: 'Insérer',
        insert: '[[]]',
        cursor: 2,
        keepOpen: true,
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

    },

    async onunload() {
      removeListeners?.()
      removeListeners = null
    },
  }
}

export { WikilinkIndexContributor } from './WikilinkIndexContributor'
export { HeadingIndexContributor } from './HeadingIndexContributor'
