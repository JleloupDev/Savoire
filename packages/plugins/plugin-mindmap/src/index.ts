// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// plugin-mindmap — éditeur de mind maps interactif pour les fichiers .mm
//
// see ADR-023

import MindElixir from 'mind-elixir'
import type { MindElixirData, MindElixirInstance } from 'mind-elixir'
import type { VaultPlugin, PluginAPI, FileContext, FileView, DocumentRoom } from '@savoire/plugin-api'

const SAVE_DEBOUNCE_MS = 500

// ── Données par défaut ────────────────────────────────────────────────────────

function defaultData(title = 'Nouvelle carte'): MindElixirData {
  return MindElixir.new(title)
}

// ── Styles ────────────────────────────────────────────────────────────────────

const CONTAINER_STYLE = [
  'height:100%', 'width:100%', 'overflow:hidden',
  'background:var(--bg-base,#1e1e2e)',
].join(';')

// ── FileView ─────────────────────────────────────────────────────────────────

function createMindmapView(
  path: string,
  ctx: FileContext,
  sync: PluginAPI['sync'],
): FileView {
  const vault = ctx.vault

  let me: MindElixirInstance | null = null
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let room: DocumentRoom | null = null
  let unsubRoom: (() => void) | null = null
  let isApplyingRemote = false
  let generation = 0

  function scheduleSave() {
    if (isApplyingRemote) return
    if (saveTimer !== null) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => flushSave(), SAVE_DEBOUNCE_MS)
  }

  function flushSave() {
    saveTimer = null
    if (!me) return
    const json = JSON.stringify(me.getData())
    if (room) {
      room.pushSnapshot(json).catch(err =>
        console.error('[plugin-mindmap] pushSnapshot error', err)
      )
    } else if (vault) {
      const docId = vault.resolveDocumentId(path)
      if (!docId) return
      vault.write(docId, json).catch(err =>
        console.error('[plugin-mindmap] save error', err)
      )
    }
  }

  function applyRemoteSnapshot(data: MindElixirData) {
    if (!me) return
    isApplyingRemote = true
    try {
      me.refresh(data)
    } catch (err) {
      console.warn('[plugin-mindmap] refresh error', err)
    } finally {
      setTimeout(() => { isApplyingRemote = false }, 0)
    }
  }

  return {
    mount(container: HTMLElement) {
      const myGen = ++generation

      // Détruire l'instance précédente si elle existe (Strict Mode double-invoke).
      if (me) {
        me.bus.removeListener('operation', scheduleSave)
        me.destroy()
        me = null
      }
      if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null }
      unsubRoom?.(); unsubRoom = null
      room?.close().catch(() => {}); room = null

      container.innerHTML = ''
      container.style.cssText = CONTAINER_STYLE

      // Mind Elixir a besoin d'un élément fils avec une hauteur explicite.
      const el = document.createElement('div')
      el.style.cssText = 'height:100%;width:100%;'
      container.appendChild(el)

      me = new MindElixir({
        el,
        direction: MindElixir.RIGHT,
        draggable: true,
        contextMenu: true,
        toolBar: true,
        keypress: true,
      })

      ;(async () => {
        let data: MindElixirData = defaultData(path.split('/').at(-1)?.replace('.mm', '') ?? 'Carte')

        if (vault) {
          try {
            const raw = await vault.readDocumentByPath(path)
            if (raw.trim()) data = JSON.parse(raw) as MindElixirData
          } catch {
            console.error('[plugin-mindmap] erreur de chargement')
          }
        }
        if (generation !== myGen || !me) return

        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
        if (generation !== myGen || !me) return

        const initErr = me.init(data)
        if (initErr) console.error('[plugin-mindmap] init error', initErr)

        // Sauvegarder à chaque opération utilisateur.
        me.bus.addListener('operation', scheduleSave)

        // Ouvrir la room de sync.
        if (sync && vault) {
          const docId = vault.resolveDocumentId(path)
          if (docId) {
            const userId = ctx.userId ?? 'anonymous'
            try {
              const openedRoom = await sync.openRoom(ctx.vaultId, docId, userId)
              if (generation !== myGen) { openedRoom.close().catch(() => {}); return }
              room = openedRoom
              unsubRoom = room.onSnapshot((snapshotJson) => {
                try {
                  applyRemoteSnapshot(JSON.parse(snapshotJson) as MindElixirData)
                } catch {
                  console.warn('[plugin-mindmap] snapshot JSON invalide')
                }
              })
            } catch (err) {
              console.warn('[plugin-mindmap] room.open error', err)
            }
          }
        }
      })()
    },

    destroy() {
      if (saveTimer !== null) { clearTimeout(saveTimer); flushSave() }
      unsubRoom?.(); unsubRoom = null
      room?.close().catch(() => {}); room = null
      if (me) { me.bus.removeListener('operation', scheduleSave); me.destroy(); me = null }
    },
  }
}

// ── Embed read-only ────────────────────────────────────────────────────────────

async function renderMindmapEmbed(path: string, ctx: FileContext): Promise<HTMLElement> {
  const wrapper = document.createElement('div')
  wrapper.style.cssText = [
    'height:320px', 'width:100%',
    'border:1px solid var(--border,#313244)',
    'border-radius:6px', 'overflow:hidden',
  ].join(';')

  const el = document.createElement('div')
  el.style.cssText = 'height:100%;width:100%;'
  wrapper.appendChild(el)

  let data: MindElixirData = defaultData(path.split('/').at(-1)?.replace('.mm', '') ?? 'Carte')

  if (ctx.vault) {
    try {
      const raw = await ctx.vault.readDocumentByPath(path)
      if (raw.trim()) data = JSON.parse(raw) as MindElixirData
    } catch { /* POC: ignoré */ }
  }

  const me = new MindElixir({
    el,
    direction: MindElixir.RIGHT,
    draggable: false,
    contextMenu: false,
    toolBar: false,
    keypress: false,
  })
  me.init(data)

  return wrapper
}

// ── Plugin ────────────────────────────────────────────────────────────────────

const plugin: VaultPlugin = {
  manifest: {
    id: 'plugin-mindmap',
    name: 'Mind Map',
    version: '0.0.1',
    description: 'Éditeur de mind maps interactif pour les fichiers .mm',
    permissions: ['ui:editor', 'vault:read', 'vault:write'],
    defaultActive: false,
  },

  async onload(api: PluginAPI) {
    api.files.register({
      extension: 'mm',
      label: 'Mind Map',
      icon: '🧠',

      // Nouveau fichier : carte vide avec un nœud racine.
      create: async () => {
        const data = defaultData('Nouvelle carte')
        return JSON.stringify(data, null, 2)
      },

      open: (path: string, ctx: FileContext) =>
        createMindmapView(path, ctx, api.sync),

      renderEmbed: (path: string, ctx: FileContext) =>
        renderMindmapEmbed(path, ctx),
    })
  },

  async onunload() {},
}

export default plugin
