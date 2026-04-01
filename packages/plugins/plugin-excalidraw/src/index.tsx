// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// plugin-excalidraw — intègre Excalidraw comme éditeur natif pour les fichiers .excalidraw.
//
// see ADR-023

import React from 'react'
import { createRoot } from 'react-dom/client'
import { Excalidraw, serializeAsJSON } from '@excalidraw/excalidraw'
import type { VaultPlugin, PluginAPI, FileContext, FileView, DocumentRoom } from '@savoire/plugin-api'
import { excalidrawContentExtractor } from './content-extractor'

type ExcalidrawProps = React.ComponentProps<typeof Excalidraw>
type ExcalidrawInitialDataState = NonNullable<ExcalidrawProps['initialData']>
type ExcalidrawImperativeAPI = Parameters<NonNullable<ExcalidrawProps['excalidrawAPI']>>[0]

type ExcalidrawChange = NonNullable<ExcalidrawProps['onChange']>
type Elements    = Parameters<ExcalidrawChange>[0]
type AppState    = Parameters<ExcalidrawChange>[1]
type BinaryFiles = Parameters<ExcalidrawChange>[2]

interface ExcalidrawAPIRef {
  updateScene(opts: { elements?: Elements; appState?: Partial<AppState>; files?: BinaryFiles }): void
}

const SAVE_DEBOUNCE_MS = 500

export { excalidrawContentExtractor } from './content-extractor'

const EMPTY_SCENE = { elements: [], appState: { viewBackgroundColor: '#1e1e2e' }, files: {} }

// ── FileView ─────────────────────────────────────────────────────────────────

function createExcalidrawView(
  path: string,
  ctx: FileContext,
  sync: PluginAPI['sync'],
): FileView {
  const vault = ctx.vault

  let root: ReturnType<typeof createRoot> | null = null
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let room: DocumentRoom | null = null
  let unsubRoom: (() => void) | null = null
  let excalidrawAPI: ExcalidrawAPIRef | null = null
  let isApplyingRemote = false
  let pendingRemoteSnapshot: unknown | null = null

  let pendingElements: Elements | null = null
  let pendingAppState: AppState | null = null
  let pendingFiles: BinaryFiles | null = null

  let generation = 0

  function scheduleSave(elements: Elements, state: AppState, files: BinaryFiles) {
    if (isApplyingRemote) return
    pendingElements = elements
    pendingAppState = state
    pendingFiles = files
    if (saveTimer !== null) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => flushSave(), SAVE_DEBOUNCE_MS)
  }

  function flushSave() {
    saveTimer = null
    if (!pendingElements || !pendingAppState || !pendingFiles) return
    const json = serializeAsJSON(pendingElements, pendingAppState, pendingFiles, 'local')
    if (room) {
      room.pushSnapshot(json).catch(err => console.error('[plugin-excalidraw] pushSnapshot error', err))
    } else if (vault) {
      const docId = vault.resolveDocumentId(path)
      if (!docId) return
      vault.write(docId, json).catch(err => console.error('[plugin-excalidraw] save error', err))
    }
    ctx.onContentStabilized?.(json)
  }

  function applyRemoteSnapshot(data: unknown) {
    if (!excalidrawAPI) {
      pendingRemoteSnapshot = data
      return
    }
    isApplyingRemote = true
    try {
      const d = data as { elements?: Elements; appState?: Partial<AppState>; files?: BinaryFiles }
      excalidrawAPI.updateScene({
        elements: d.elements ?? [],
        appState: d.appState ?? {},
        files: d.files ?? {},
      })
    } finally {
      setTimeout(() => { isApplyingRemote = false }, 0)
    }
  }

  function ExcalidrawEditor({ initialData }: { initialData: unknown }) {
    return (
      <div style={{ height: '100%', width: '100%' }}>
        <Excalidraw
          initialData={initialData as ExcalidrawInitialDataState}
          onChange={scheduleSave}
          theme="dark"
          excalidrawAPI={(api: ExcalidrawImperativeAPI) => {
            excalidrawAPI = api as ExcalidrawAPIRef
            if (pendingRemoteSnapshot !== null) {
              const snap = pendingRemoteSnapshot
              pendingRemoteSnapshot = null
              applyRemoteSnapshot(snap)
            }
          }}
        />
      </div>
    )
  }

  return {
    mount(container: HTMLElement) {
      // Incrémenter la génération — invalide tous les callbacks async du mount précédent.
      const myGen = ++generation

      // Démonter le root précédent synchroniquement pour éviter l'avertissement
      // React "createRoot on a container that already has a root".
      if (root) { root.unmount(); root = null }

      // Réinitialiser l'état partagé.
      if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null }
      unsubRoom?.(); unsubRoom = null
      room?.close().catch(() => {}); room = null
      excalidrawAPI = null
      pendingRemoteSnapshot = null

      container.innerHTML = ''
      container.style.cssText = 'height:100%;width:100%;overflow:hidden'
      root = createRoot(container)

      ;(async () => {
        let initialData: unknown = EMPTY_SCENE
        if (vault) {
          try {
            const raw = await vault.readDocumentByPath(path)
            if (raw.trim()) initialData = JSON.parse(raw)
          } catch {
            console.error('[plugin-excalidraw] erreur de chargement')
          }
        }
        // Vérifier que ce mount() est toujours le courant.
        if (generation !== myGen) return

        root?.render(<ExcalidrawEditor initialData={initialData} />)

        if (sync && vault) {
          const docId = vault.resolveDocumentId(path)
          if (docId) {
            const userId = ctx.userId ?? 'anonymous'
            try {
              const openedRoom = await sync.openRoom(ctx.vaultId, docId, userId)
              if (generation !== myGen) { openedRoom.close().catch(() => {}); return }
              room = openedRoom
              unsubRoom = room.onSnapshot((snapshotJson) => {
                try { applyRemoteSnapshot(JSON.parse(snapshotJson)) }
                catch { console.warn('[plugin-excalidraw] snapshot JSON invalide') }
              })
            } catch (err) {
              console.warn('[plugin-excalidraw] room.open error', err)
            }
          }
        }
      })()
    },

    destroy() {
      // Invalider tout async en cours : le prochain mount() incrémentera generation.
      // Ne pas incrémenter ici — destroy() seul (sans mount() après) doit juste nettoyer.
      if (saveTimer !== null) { clearTimeout(saveTimer); flushSave() }
      unsubRoom?.(); unsubRoom = null
      room?.close().catch(() => {}); room = null
      excalidrawAPI = null
      pendingRemoteSnapshot = null
      root?.unmount()
      root = null
    },
  }
}

// ── Plugin ────────────────────────────────────────────────────────────────────

const plugin: VaultPlugin = {
  manifest: {
    id: 'plugin-excalidraw',
    name: 'Excalidraw',
    version: '0.0.1',
    description: 'Éditeur de dessin vectoriel Excalidraw pour les fichiers .excalidraw',
    permissions: ['ui:editor', 'vault:read', 'vault:write'],
    defaultActive: false,
  },

  async onload(api: PluginAPI) {
    api.files.register({
      extension: 'excalidraw',
      label: 'Dessin Excalidraw',
      icon: '✏️',

      create: async () => JSON.stringify(EMPTY_SCENE, null, 2),

      open: (path: string, ctx: FileContext) =>
        createExcalidrawView(path, ctx, api.sync),

      contentExtractor: excalidrawContentExtractor,

      renderEmbed: async (path: string, ctx: FileContext): Promise<HTMLElement> => {
        const wrapper = document.createElement('div')
        wrapper.style.cssText = [
          'height:320px', 'width:100%',
          'border:1px solid var(--border,#313244)',
          'border-radius:6px', 'overflow:hidden',
        ].join(';')

        let initialData: unknown = EMPTY_SCENE
        if (ctx.vault) {
          try {
            const raw = await ctx.vault.readDocumentByPath(path)
            if (raw.trim()) initialData = JSON.parse(raw)
          } catch { /* POC: ignoré */ }
        }

        const embedRoot = createRoot(wrapper)
        embedRoot.render(
          <div style={{ height: '100%', width: '100%' }}>
            <Excalidraw
              initialData={initialData as ExcalidrawInitialDataState}
              viewModeEnabled
              theme="dark"
            />
          </div>
        )

        return wrapper
      },
    })
  },

  async onunload() {},
}

export default plugin
