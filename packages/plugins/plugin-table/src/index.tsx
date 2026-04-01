// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// plugin-table — fichiers .table avec formules, tri et filtres.
//
// Stockage : GFM Markdown table (lisible dans tout éditeur Markdown).
// Les formules (=SUM, =AVERAGE, =IF, ...) sont stockées comme texte brut dans les cellules.
// HyperFormula les évalue côté client. Le fichier reste du Markdown valide.
//
// Modes :
//   open()         → éditeur plein écran (FileView dans un panneau Dockview)
//   renderEmbed()  → éditeur inline dans plugin-module (mode Edit)
//
// Sync : DocumentRoom (/hubs/room) — last-write-wins, même modèle qu'Excalidraw.
//
// Scope activation (dans le frontmatter d'une note) :
//   plugins: plugin-table:auto

import { createRoot } from 'react-dom/client'
import type { VaultPlugin, PluginAPI, FileContext, FileView, BlockContext } from '@savoire/plugin-api'
import { TableEditor } from './TableEditor'
import { parseGfmTable, serializeGfmTable, DEFAULT_TABLE } from './gfm'
import type { TableData } from './gfm'

const SAVE_DEBOUNCE_MS = 600

// ── FileView factory ──────────────────────────────────────────────────────

function createTableView(
  path: string,
  ctx: FileContext,
  sync: PluginAPI['sync'],
  embedHeight?: number,
): FileView {
  const vault = ctx.vault
  let root: ReturnType<typeof createRoot> | null = null
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let currentData: TableData = DEFAULT_TABLE
  let destroyed = false

  function scheduleSave(data: TableData) {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(async () => {
      if (destroyed || !vault) return
      const content = serializeGfmTable(data)
      const docId = vault.resolveDocumentId?.(path)
      if (docId) {
        await vault.write(docId, content).catch(console.error)
      }
    }, SAVE_DEBOUNCE_MS)
  }

  function renderComponent(container: HTMLElement, data: TableData) {
    if (!root) root = createRoot(container)
    root.render(
      <TableEditor
        initialData={data}
        onChange={newData => {
          currentData = newData
          scheduleSave(newData)
        }}
        height={embedHeight ?? 360}
      />
    )
  }

  return {
    mount(container: HTMLElement) {
      destroyed = false
      if (!vault) {
        container.textContent = '⚠ Vault non disponible'
        return
      }

      // Load content then mount
      vault.readDocumentByPath(path).then(source => {
        if (destroyed) return
        currentData = parseGfmTable(source) ?? DEFAULT_TABLE
        if (currentData.headers.length === 0) currentData = DEFAULT_TABLE
        renderComponent(container, currentData)
      }).catch(() => {
        if (destroyed) return
        // File doesn't exist yet — use empty table
        renderComponent(container, DEFAULT_TABLE)
      })

      // ── DocumentRoom sync ──────────────────────────────────────────────
      if (sync && ctx.userId) {
        const vaultId = ctx.vaultId
        const docId   = vault.resolveDocumentId?.(path)
        if (vaultId && docId) {
          sync.openRoom(vaultId, docId, ctx.userId).then(room => {
            if (destroyed) { room.close(); return }

            room.onSnapshot((json, fromUserId) => {
              if (fromUserId === ctx.userId) return  // ignore own echoes
              try {
                const remote = JSON.parse(json) as TableData
                currentData = remote
                const el = root  // re-render with remote data
                if (el) renderComponent(document.querySelector('.table-view-root') as HTMLElement, remote)
              } catch { /* ignore malformed snapshots */ }
            })
          }).catch(() => { /* sync unavailable */ })
        }
      }
    },

    destroy() {
      destroyed = true
      if (saveTimer) clearTimeout(saveTimer)
      root?.unmount()
      root = null
    },
  }
}

// ── Plugin ────────────────────────────────────────────────────────────────

const plugin: VaultPlugin = {
  manifest: {
    id: 'plugin-table',
    name: 'Tables',
    version: '1.0.0',
    description: 'Fichiers .table avec formules (HyperFormula) et tri',
    permissions: ['ui:editor', 'vault:read', 'vault:write'],
    defaultActive: true,
  },

  async onload(api: PluginAPI) {
    api.files.register({
      extension: 'table',
      label: 'Tableau',
      icon: '📊',

      // Default content for a new .table file
      async create() {
        return serializeGfmTable(DEFAULT_TABLE)
      },

      // Full-screen editor (opened in a Dockview panel)
      open(path: string, ctx: FileContext): FileView {
        return createTableView(path, ctx, api.sync)
      },

      async renderEmbed(path: string, ctx: FileContext): Promise<HTMLElement> {
        const container = document.createElement('div')
        container.style.cssText = 'min-height:200px;padding:4px 0'

        const view = createTableView(path, ctx, api.sync, 260)
        view.mount(container)

        ;(container as HTMLElement & { __destroy?: () => void }).__destroy = () => view.destroy()

        return container
      },
    })

    // ── Inline table block (```table ... ```) ─────────────────────────────
    api.blocks.register({
      type: 'inline-table',

      detect(text: string): boolean {
        return text.trimStart().startsWith('```table')
      },

      deserialize(raw: string): TableData {
        // Strip ```table\n...\n``` wrapper
        const inner = raw
          .replace(/^```table\r?\n/, '')
          .replace(/\r?\n```\s*$/, '')
        return parseGfmTable(inner)
      },

      serialize(data: unknown): string {
        return '```table\n' + serializeGfmTable(data as TableData) + '\n```'
      },

      createEditorWidget: (_data, _ctx) => ({ mount: (_el) => {}, destroy: () => {} }),

      renderClient(data: unknown, ctx: BlockContext): HTMLElement {
        const tableData = data as TableData

        let currentRaw = '```table\n' + serializeGfmTable(tableData) + '\n```'

        const container = document.createElement('div')
        container.style.cssText = 'padding:2px 0'
        // Prevent CM6 from reclaiming focus when the user clicks inside the grid
        container.addEventListener('mousedown', e => e.stopPropagation())
        container.addEventListener('click',     e => e.stopPropagation())

        const root = createRoot(container)
        root.render(
          <TableEditor
            initialData={tableData}
            onChange={(newData: TableData) => {
              const newRaw = '```table\n' + serializeGfmTable(newData) + '\n```'
              // Locate and replace the block in the CM6 document
              const view = ctx.editorView as { dispatch: (tx: unknown) => void; state: { doc: { toString(): string } } }
              const docText = view.state.doc.toString()
              const from = docText.indexOf(currentRaw)
              if (from >= 0) {
                view.dispatch({ changes: { from, to: from + currentRaw.length, insert: newRaw } })
              }
              currentRaw = newRaw
            }}
            height={220}
          />
        )

        return container
      },

      trigger: {
        id: 'table:inline',
        label: 'Tableau interactif',
        description: 'Tableau éditable avec formules (HyperFormula)',
        icon: '📊',
        category: 'Blocs',
        insert: '```table\n| Col A | Col B | Total |\n| ----- | ----- | ----- |\n|       |       |       |\n```',
      },
    })

    // Slash command to insert a new table module
    api.slash.register({
      id: 'table:new',
      label: 'Nouveau tableau (.table)',
      description: "Crée un fichier .table et l'insère comme module",
      icon: '📊',
      category: 'Modules',
      insert: () => '@[[nouveau-tableau.table]]',
    })
  },

  async onunload() {},
}

export default plugin
