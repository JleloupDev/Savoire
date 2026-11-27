// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Plugin core « Favoris » : un panneau dans la barre de gauche, une etoile
// pour la note ouverte (commande), et les commandes des « Signets »
// d'Obsidian sous leur identifiant (bookmarks:*). Voir bookmarkStore.ts.
import { useEffect, useState } from 'react'
import type { PluginAPI, ViewContext, VaultPlugin, Widget } from '@savoire/plugin-api'
import { BookmarkStore, moveBookmark, type Bookmark } from './bookmarkStore'

export const BOOKMARKS_VIEW = 'bookmarks'

/** Le titre le plus proche au-dessus de la ligne `line` (« Partie 1 »), ou null. */
export function headingAbove(lines: readonly string[], line: number): string | null {
  for (let i = Math.min(line, lines.length - 1); i >= 0; i--) {
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(lines[i])
    if (m) return m[1]
  }
  return null
}

function nameOf(path: string): string {
  const last = path.replace(/\/$/, '').split('/').at(-1) ?? path
  return last.replace(/\.md$/i, '')
}

/** Ce qu'on montre d'un favori, et ou il mene. */
function describe(b: Bookmark, pathOf: (docId: string) => string | undefined): { label: string; detail: string; missing: boolean } {
  if (b.type === 'url') return { label: b.title || b.url, detail: b.url, missing: false }
  if (b.type === 'folder') return { label: b.title || nameOf(b.path), detail: b.path, missing: false }
  const current = b.docId ? pathOf(b.docId) : undefined
  const path = current ?? b.path
  const label = b.title || (b.subpath ? `${nameOf(path)} › ${b.subpath.replace(/^\^/, '')}` : nameOf(path))
  return { label, detail: path, missing: !!b.docId && !current }
}

function BookmarksPanel({ ctx, store, open }: { ctx: ViewContext; store: BookmarkStore; open(b: Bookmark): void }) {
  const [list, setList] = useState(() => store.all())
  const [, setTick] = useState(0)
  useEffect(() => store.subscribe(() => setList([...store.all()])), [store])
  // Une note renommee : son nouveau nom s'affiche.
  useEffect(() => ctx.workspace.subscribeVaultChange?.(() => setTick(t => t + 1)), [ctx])
  const pathOf = (docId: string) => ctx.vault.getFileTree?.().find(f => f.docId === docId)?.path

  const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 13 }
  const small: React.CSSProperties = { border: 'none', background: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: '0 3px', fontSize: 12 }
  return (
    <div data-testid="bookmarks-panel" style={{ height: '100%', overflow: 'auto', paddingTop: 4, color: 'inherit', fontFamily: 'inherit' }}>
      {list.length === 0 && (
        <div style={{ padding: '10px 12px', fontSize: 12, color: 'var(--text-faint)', lineHeight: 1.5 }}>
          Aucun favori. Palette de commandes › « Ajouter la note aux favoris », ou « Ajouter ce titre aux favoris » depuis une note.
        </div>
      )}
      {list.map((b, i) => {
        const d = describe(b, pathOf)
        return (
          <div key={i} data-testid="bookmark-item" style={{ ...row, opacity: d.missing ? 0.5 : 1 }} title={d.detail} onClick={() => open(b)}>
            <span aria-hidden style={{ color: 'var(--accent)' }}>{b.type === 'folder' ? '📁' : b.type === 'url' ? '🔗' : '★'}</span>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.label}</span>
            <button type="button" aria-label="Monter" style={small} onClick={e => { e.stopPropagation(); store.set(moveBookmark(store.all(), i, -1)) }}>↑</button>
            <button type="button" aria-label="Descendre" style={small} onClick={e => { e.stopPropagation(); store.set(moveBookmark(store.all(), i, 1)) }}>↓</button>
            <button type="button" aria-label="Retirer des favoris" data-testid="bookmark-remove" style={small} onClick={e => { e.stopPropagation(); store.set(store.all().filter((_, k) => k !== i)) }}>✕</button>
          </div>
        )
      })}
    </div>
  )
}

class BookmarksWidget implements Widget {
  constructor(private readonly ctx: ViewContext, private readonly store: BookmarkStore, private readonly open: (b: Bookmark) => void) {}
  render() {
    return <BookmarksPanel ctx={this.ctx} store={this.store} open={this.open} />
  }
}

/** Une vue de texte (CodeMirror), vue de loin : la ligne du curseur et le texte. */
function cursorContext(view: unknown): { lines: string[]; line: number } | null {
  const v = view as { state?: { doc: { toString(): string; lineAt(p: number): { number: number } }; selection: { main: { head: number } } } } | null
  if (!v?.state) return null
  return { lines: v.state.doc.toString().split('\n'), line: v.state.doc.lineAt(v.state.selection.main.head).number - 1 }
}

export { BookmarkStore, moveBookmark, sameBookmark, toggleBookmark, type Bookmark } from './bookmarkStore'

export function createBookmarksPlugin(store: BookmarkStore = new BookmarkStore()): VaultPlugin {
  let stop: (() => void) | null = null
  return {
    manifest: {
      id: 'plugin-bookmarks',
      name: 'Favoris',
      version: '0.0.1',
      description: 'Vos notes, passages, dossiers et liens favoris, dans la barre de gauche',
      scope: 'vault',
      permissions: ['vault:read'],
      defaultActive: true,
      official: true,
    },

    async onload(api: PluginAPI) {
      const attach = () => store.attach(api.vault.getVaultId?.() ?? null, api.vault.getCurrentUser?.()?.id ?? null)
      attach()
      stop = api.workspace.subscribeVaultChange?.(attach) ?? null

      const notify = (title: string, message?: string) => api.workspace.notify?.('info', title, message)
      const activeFile = (): Bookmark | null => {
        const path = api.workspace.getActiveDocument()?.path
        if (!path) return null
        return { type: 'file', path, docId: api.vault.resolveDocumentId(path) ?? undefined }
      }
      const open = (b: Bookmark) => {
        if (b.type === 'url') { window.open(b.url, '_blank', 'noopener'); return }
        if (b.type === 'folder') { notify('Dossier favori', b.path); return }
        const path = (b.docId ? api.vault.getFileTree?.().find(f => f.docId === b.docId)?.path : undefined) ?? b.path
        void (b.subpath ? api.workspace.openFile(path, { subpath: b.subpath }) : api.workspace.openFile(path))
      }

      api.views.register({
        id: BOOKMARKS_VIEW,
        title: 'Favoris',
        icon: 'star',
        container: 'left',
        ribbon: true,
        initialSize: 260,
        closable: true,
        createView: ctx => new BookmarksWidget(ctx, store, open),
      })

      api.commands.register({ id: 'bookmarks:open', label: 'Afficher les favoris', run: () => api.workspace.openPanel(BOOKMARKS_VIEW) })
      api.commands.register({
        id: 'bookmarks:bookmark-current-view',
        label: 'Ajouter la note aux favoris (ou l\'en retirer)',
        run: () => {
          const b = activeFile()
          if (!b) return
          notify(store.toggle(b) ? 'Ajoutée aux favoris' : 'Retirée des favoris', b.type === 'file' ? nameOf(b.path) : undefined)
        },
      })
      api.commands.register({
        id: 'bookmarks:unbookmark-current-view',
        label: 'Retirer la note des favoris',
        run: () => {
          const b = activeFile()
          if (b && store.has(b)) { store.toggle(b); notify('Retirée des favoris') }
        },
      })
      const bookmarkHeading = (ctx: { editorView: unknown }) => {
        const b = activeFile()
        const at = cursorContext(ctx.editorView)
        const heading = at ? headingAbove(at.lines, at.line) : null
        if (!b || b.type !== 'file' || !heading) { notify('Favori', 'Placez le curseur sous un titre.'); return }
        notify(store.toggle({ ...b, subpath: heading }) ? 'Titre ajouté aux favoris' : 'Titre retiré des favoris', heading)
      }
      api.commands.register({ id: 'bookmarks:bookmark-current-heading', label: 'Ajouter ce titre aux favoris', run: bookmarkHeading })
      api.commands.register({ id: 'bookmarks:bookmark-current-section', label: 'Ajouter cette partie aux favoris', run: bookmarkHeading })
    },

    async onunload() {
      stop?.()
      stop = null
    },
  }
}
