// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// plugin-excalidraw — intègre Excalidraw comme éditeur natif pour les fichiers .excalidraw.
//
// see ADR-023
//
// Edition a plusieurs : la scene est rangee dans l'arbre partage du document
// (ctx.tree), un element par cle. Plusieurs membres dessinent en meme temps,
// sans verrou (voir binding.ts). Sans arbre (pas de session de vault), la
// vue est en lecture seule : ecrire des instantanes sans verrou ferait perdre
// en silence le travail d'un autre.
//
// Ancien fichier (instantane JSON, avant le passage en CRDT) : relu par la
// room de synchro et recopie dans l'arbre a la premiere ouverture (voir
// migrateLegacy).

import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Excalidraw, restoreElements } from '@excalidraw/excalidraw'
import type { VaultPlugin, PluginAPI, FileContext, FileView, DocumentRoom, ISharedTree } from '@savoire/plugin-api'
import { excalidrawContentExtractor } from './content-extractor'
import { SceneBinding, type SceneElement, type SceneFile, type StoredFile } from './binding'

type ExcalidrawProps = React.ComponentProps<typeof Excalidraw>
type ExcalidrawInitialDataState = NonNullable<ExcalidrawProps['initialData']>
type ExcalidrawImperativeAPI = Parameters<NonNullable<ExcalidrawProps['excalidrawAPI']>>[0]
type ExcalidrawChange = NonNullable<ExcalidrawProps['onChange']>
type Elements = Parameters<ExcalidrawChange>[0]
type BinaryFiles = Parameters<ExcalidrawChange>[2]
type PointerPayload = Parameters<NonNullable<ExcalidrawProps['onPointerUpdate']>>[0]
type Collaborators = NonNullable<Parameters<ExcalidrawImperativeAPI['updateScene']>[0]['collaborators']>
type Collaborator = Collaborators extends Map<string, infer C> ? C : never

export { excalidrawContentExtractor } from './content-extractor'
export { SceneBinding, assignOrder, isBetter } from './binding'
export type { SceneElement, SceneFile, StoredFile, SceneBindingOptions } from './binding'

const EMPTY_SCENE = { elements: [], appState: { viewBackgroundColor: '#1e1e2e' }, files: {} }
const STABILIZE_MS = 1000
/** Temps sans changement de l'arbre avant de conclure qu'il est vide. */
const SETTLE_MS = 800
const SETTLE_MAX_MS = 4000
const ROOM_TIMEOUT_MS = 4000
const PRESENCE_MS = 60
const PRESENCE_TTL_MS = 15000
/** Marque posee dans l'ancien instantane une fois recopie dans l'arbre. */
const MIGRATED_FLAG = 'savoireCrdt'

interface LegacyScene {
  elements?: unknown[]
  files?: Record<string, SceneFile>
  [key: string]: unknown
}

function parseLegacy(raw: string | null | undefined): LegacyScene | null {
  if (!raw || !raw.trim()) return null
  try {
    const data = JSON.parse(raw) as LegacyScene
    if (!data || typeof data !== 'object' || data[MIGRATED_FLAG]) return null
    const hasContent = (data.elements?.length ?? 0) > 0 || Object.keys(data.files ?? {}).length > 0
    return hasContent ? data : null
  } catch {
    return null
  }
}

/** Attend que l'arbre se taise : le contenu deja connu arrive juste apres l'ouverture. */
function settle(tree: ISharedTree): Promise<void> {
  return new Promise(resolve => {
    let quiet: ReturnType<typeof setTimeout>
    const done = () => { clearTimeout(quiet); clearTimeout(max); unsub(); resolve() }
    const max = setTimeout(done, SETTLE_MAX_MS)
    const unsub = tree.onChange(() => { clearTimeout(quiet); quiet = setTimeout(done, SETTLE_MS) })
    quiet = setTimeout(done, SETTLE_MS)
  })
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>(r => setTimeout(() => r(null), ms))])
}

const EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp',
}

function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

function colorOf(userId: string): { background: string; stroke: string } {
  let h = 0
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) % 360
  return { background: `hsl(${h} 70% 75%)`, stroke: `hsl(${h} 70% 45%)` }
}

// ── FileView ─────────────────────────────────────────────────────────────────

function createExcalidrawView(path: string, ctx: FileContext, api: PluginAPI | null): FileView {
  const vault = ctx.vault
  const sync = api?.sync
  const tree = ctx.tree

  let root: ReturnType<typeof createRoot> | null = null
  let excalidrawAPI: ExcalidrawImperativeAPI | null = null
  let binding: SceneBinding | null = null
  let room: DocumentRoom | null = null
  let unsubPresence: (() => void) | null = null
  let pruneTimer: ReturnType<typeof setInterval> | null = null
  let stabilizeTimer: ReturnType<typeof setTimeout> | null = null
  let presenceTimer: ReturnType<typeof setTimeout> | null = null
  let pendingPointer: PointerPayload | null = null
  let keyTarget: HTMLElement | null = null
  let generation = 0

  let readOnly = !!ctx.readOnly
  /** Lecture seule imposee : pas d'arbre, ou migration en cours. */
  let blocked = !tree
  let setViewMode: ((v: boolean) => void) | null = null
  let onApiReady: (() => void) | null = null
  const collaborators = new Map<string, Collaborator & { seen: number }>()

  function applyEditable(): void {
    const view = readOnly || blocked
    setViewMode?.(view)
    binding?.setWritable(!view)
  }

  function sceneElements(): SceneElement[] | null {
    if (!excalidrawAPI) return null
    return excalidrawAPI.getSceneElementsIncludingDeleted() as unknown as SceneElement[]
  }

  function busyIds(): Set<string> {
    const ids = new Set<string>()
    if (!excalidrawAPI) return ids
    const s = excalidrawAPI.getAppState()
    for (const el of [s.editingElement, s.draggingElement, s.resizingElement, s.multiElement]) {
      if (el) ids.add(el.id)
    }
    if (s.selectedElementsAreBeingDragged || s.isResizing || s.isRotating) {
      for (const [id, on] of Object.entries(s.selectedElementIds)) if (on) ids.add(id)
    }
    return ids
  }

  function scheduleStabilize(): void {
    if (!ctx.onContentStabilized) return
    if (stabilizeTimer) clearTimeout(stabilizeTimer)
    stabilizeTimer = setTimeout(() => {
      stabilizeTimer = null
      const els = sceneElements()
      if (!els) return
      ctx.onContentStabilized?.(JSON.stringify({ elements: els.filter(e => !e.isDeleted) }))
    }, STABILIZE_MS)
  }

  async function storeFile(file: SceneFile): Promise<StoredFile> {
    const meta = { mimeType: file.mimeType, created: file.created }
    if (!vault?.uploadAttachment) return { ...meta, dataURL: file.dataURL }
    const blob = await (await fetch(file.dataURL)).blob()
    const name = `excalidraw-${file.id.slice(0, 16)}.${EXT[file.mimeType] ?? 'bin'}`
    const stored = await vault.uploadAttachment(new File([blob], name, { type: file.mimeType }))
    return { ...meta, path: stored }
  }

  async function loadFile(id: string, stored: StoredFile): Promise<SceneFile | null> {
    if (!stored.path || !vault?.resolveAttachmentUrl) return null
    const url = await vault.resolveAttachmentUrl(stored.path)
    const blob = await (await fetch(url)).blob()
    return { id, mimeType: stored.mimeType, created: stored.created ?? Date.now(), dataURL: await blobToDataURL(blob) }
  }

  function onChange(_elements: Elements, _state: unknown, files: BinaryFiles): void {
    binding?.localChange(files as unknown as Record<string, SceneFile>)
    scheduleStabilize()
  }

  // ── Presence (curseurs des autres), par la room de synchro ──────────────

  function onPointerUpdate(payload: PointerPayload): void {
    if (!room) return
    pendingPointer = payload
    if (presenceTimer) return
    presenceTimer = setTimeout(() => {
      presenceTimer = null
      const p = pendingPointer
      if (!p || !room) return
      const userId = ctx.userId ?? 'anonymous'
      room.updatePresence({
        userId,
        displayName: ctx.userName,
        color: colorOf(userId).stroke,
        excalidraw: { pointer: p.pointer, button: p.button },
      }).catch(() => {})
    }, PRESENCE_MS)
  }

  function showCollaborators(): void {
    if (!excalidrawAPI) return
    const map = new Map<string, Collaborator>()
    for (const [id, c] of collaborators) {
      const { seen: _seen, ...rest } = c
      map.set(id, rest)
    }
    excalidrawAPI.updateScene({ collaborators: map })
  }

  function listenPresence(r: DocumentRoom): void {
    unsubPresence = r.onPresence((userId, presence) => {
      if (userId === ctx.userId) return
      const x = presence.excalidraw as { pointer?: Collaborator['pointer']; button?: 'up' | 'down' } | undefined
      if (!x?.pointer) return
      collaborators.set(userId, {
        id: userId,
        pointer: x.pointer,
        button: x.button,
        username: presence.displayName ?? userId,
        color: colorOf(userId),
        seen: Date.now(),
      })
      showCollaborators()
    })
    pruneTimer = setInterval(() => {
      const limit = Date.now() - PRESENCE_TTL_MS
      let changed = false
      for (const [id, c] of collaborators) if (c.seen < limit) { collaborators.delete(id); changed = true }
      if (changed) showCollaborators()
    }, PRESENCE_TTL_MS / 3)
  }

  // ── Ancien contenu ───────────────────────────────────────────────────────
  //
  // Avant le CRDT, le dessin etait un instantane JSON. A l'ouverture, si cet
  // instantane existe et n'est pas marque, et si l'arbre est encore vide une
  // fois le contenu connu arrive (settle), on le recopie dans l'arbre puis on
  // marque l'instantane (sans l'effacer). Deux membres qui migrent en meme
  // temps ecrivent les memes elements (memes ids, versions et nonces) et les
  // memes rangs : le resultat est identique, quel que soit le gagnant. Un
  // membre arrive apres la marque ne migre plus. Un membre qui migrerait
  // pendant qu'un autre modifie deja reecrirait d'anciennes versions ; la
  // vue qui tient la version plus haute la reecrit aussitot (binding.ts).

  async function migrateLegacy(myGen: number, legacy: LegacyScene, r: DocumentRoom): Promise<void> {
    await settle(tree!)
    if (generation !== myGen || !binding) return
    if (!binding.isEmpty()) { binding.resetFromTree(); return }
    await waitApi()
    if (generation !== myGen || !excalidrawAPI || !binding) return
    const elements = restoreElements(legacy.elements as never, null)
    const files = Object.values(legacy.files ?? {})
    if (files.length) excalidrawAPI.addFiles(files as never)
    excalidrawAPI.updateScene({ elements })
    binding.setWritable(!readOnly)
    if (readOnly) return
    binding.localChange(legacy.files ?? {})
    binding.flush()
    r.pushSnapshot(JSON.stringify({ ...legacy, [MIGRATED_FLAG]: 1 })).catch(err =>
      console.warn('[plugin-excalidraw] marque de migration non posee', err))
  }

  function waitApi(): Promise<void> {
    if (excalidrawAPI) return Promise.resolve()
    return new Promise(resolve => { onApiReady = resolve })
  }

  // ── Raccourcis ───────────────────────────────────────────────────────────
  //
  // Les touches avec Ctrl, Alt ou Cmd passent d'abord par le moteur de
  // raccourcis (palette, navigation...) ; ce qu'il ne prend pas reste a
  // Excalidraw (annuler, copier, grouper...). Les lettres seules (outils :
  // V, R, T...) restent a Excalidraw : le moteur n'en lie jamais.
  function onKeyDownCapture(event: KeyboardEvent): void {
    if (event.isComposing || !(event.ctrlKey || event.altKey || event.metaKey)) return
    if (api?.hotkeys?.handleKeyEvent(event, { editorView: null })) event.stopPropagation()
  }

  function ExcalidrawEditor({ initialData }: { initialData: unknown }) {
    const [view, setView] = useState(readOnly || blocked)
    setViewMode = setView
    return (
      <div style={{ height: '100%', width: '100%' }} data-testid="excalidraw-view" data-readonly={view ? 'true' : 'false'}>
        <Excalidraw
          initialData={initialData as ExcalidrawInitialDataState}
          onChange={onChange}
          onPointerUpdate={onPointerUpdate}
          viewModeEnabled={view}
          theme="dark"
          excalidrawAPI={(a: ExcalidrawImperativeAPI) => {
            excalidrawAPI = a
            if (tree && !blocked) binding?.resetFromTree()
            const ready = onApiReady
            onApiReady = null
            ready?.()
          }}
        />
      </div>
    )
  }

  /**
   * Demonte la racine React hors du rendu en cours : la vue peut etre
   * detruite pendant un rendu de l'hote, et un demontage synchrone y
   * provoquait « removeChild: node is not a child of this node ».
   */
  function unmountRoot(): void {
    const r = root
    root = null
    if (r) setTimeout(() => r.unmount(), 0)
  }

  function cleanup(): void {
    if (stabilizeTimer) { clearTimeout(stabilizeTimer); stabilizeTimer = null }
    if (presenceTimer) { clearTimeout(presenceTimer); presenceTimer = null }
    if (pruneTimer) { clearInterval(pruneTimer); pruneTimer = null }
    keyTarget?.removeEventListener('keydown', onKeyDownCapture, true)
    keyTarget = null
    binding?.destroy(); binding = null
    unsubPresence?.(); unsubPresence = null
    room?.close().catch(() => {}); room = null
    excalidrawAPI = null
    onApiReady = null
    collaborators.clear()
  }

  return {
    mount(container: HTMLElement) {
      // Incrémenter la génération — invalide tous les callbacks async du mount précédent.
      const myGen = ++generation
      unmountRoot()
      cleanup()

      // La racine React vit dans son propre noeud : un demontage differe
      // (voir unmountRoot) ne touche jamais au conteneur d'une vue suivante.
      const host = document.createElement('div')
      host.style.cssText = 'height:100%;width:100%'
      container.replaceChildren(host)
      container.style.cssText = 'height:100%;width:100%;overflow:hidden'
      container.addEventListener('keydown', onKeyDownCapture, true)
      keyTarget = container
      root = createRoot(host)

      if (!tree) {
        // Pas d'arbre partage : on affiche le fichier, sans l'editer.
        blocked = true
        ;(async () => {
          let initialData: unknown = EMPTY_SCENE
          try {
            const raw = vault ? await vault.readDocumentByPath(path) : ''
            if (raw.trim()) initialData = JSON.parse(raw)
          } catch {
            console.error('[plugin-excalidraw] erreur de chargement')
          }
          if (generation === myGen) root?.render(<ExcalidrawEditor initialData={initialData} />)
        })()
        return
      }

      binding = new SceneBinding({
        tree,
        getElements: sceneElements,
        getBusyIds: busyIds,
        applyElements: els => excalidrawAPI?.updateScene({ elements: els as unknown as Elements }),
        hasFile: id => !!excalidrawAPI?.getFiles()[id],
        addFiles: files => excalidrawAPI?.addFiles(files as never),
        storeFile,
        loadFile,
        onRemoteApplied: scheduleStabilize,
      })
      binding.start()

      // L'ancien contenu eventuel est lu avant d'autoriser l'ecriture : sans
      // cela, un premier trait ecrirait une scene vide par-dessus.
      const docId = vault?.resolveDocumentId(path)
      blocked = !!(sync && docId)
      binding.setWritable(!blocked && !readOnly)
      root.render(<ExcalidrawEditor initialData={EMPTY_SCENE} />)
      if (!blocked) return

      ;(async () => {
        try {
          const opened = await withTimeout(sync!.openRoom(ctx.vaultId, docId!, ctx.userId ?? 'anonymous'), ROOM_TIMEOUT_MS)
          if (generation !== myGen) { opened?.close().catch(() => {}); return }
          if (opened) {
            room = opened
            listenPresence(opened)
            const legacy = parseLegacy((await opened.initialSnapshot) ?? null)
            if (legacy) {
              await migrateLegacy(myGen, legacy, opened)
              if (generation !== myGen) return
            }
          }
        } catch (err) {
          console.warn('[plugin-excalidraw] room.open error', err)
        }
        blocked = false
        applyEditable()
      })()
    },

    setReadOnly(next: boolean) {
      readOnly = next
      applyEditable()
    },

    destroy() {
      // Invalide les suites async du mount en cours (room, migration).
      generation++
      cleanup()
      unmountRoot()
    },
  }
}

// ── Plugin ────────────────────────────────────────────────────────────────────

let pluginAPI: PluginAPI | null = null

const plugin: VaultPlugin = {
  manifest: {
    id: 'plugin-excalidraw',
    scope: 'vault',
    name: 'Excalidraw',
    version: '0.0.2',
    description: 'Éditeur de dessin vectoriel Excalidraw pour les fichiers .excalidraw',
    permissions: ['ui:editor', 'vault:read', 'vault:write'],
    defaultActive: false,
  },

  async onload(api: PluginAPI) {
    pluginAPI = api
    api.files.register({
      extension: 'excalidraw',
      label: 'Dessin Excalidraw',
      icon: '✏️',
      // La scene est un CRDT (un element par cle de l'arbre partage) :
      // edition simultanee, sans verrou.
      collaborationMode: 'crdt',

      // Non ecrit pour un type 'crdt' : la vue pose la scene a la premiere
      // modification.
      create: async () => JSON.stringify(EMPTY_SCENE, null, 2),

      open: (path: string, ctx: FileContext) => createExcalidrawView(path, ctx, pluginAPI),

      contentExtractor: excalidrawContentExtractor,

      renderEmbed: async (path: string, ctx: FileContext): Promise<HTMLElement> => {
        const wrapper = document.createElement('div')
        wrapper.style.cssText = [
          'height:320px', 'width:100%',
          'border:1px solid var(--border,#313244)',
          'border-radius:6px', 'overflow:hidden',
        ].join(';')

        let initialData: unknown = EMPTY_SCENE
        if (ctx.tree) {
          // Lecture ponctuelle de l'arbre, sans abonnement.
          const b = new SceneBinding({
            tree: ctx.tree, getElements: () => null, applyElements: () => {}, hasFile: () => false, addFiles: () => {},
          })
          initialData = { ...EMPTY_SCENE, elements: b.readElements() }
        } else if (ctx.vault) {
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

  async onunload() {
    pluginAPI?.files.unregister('excalidraw')
    pluginAPI = null
  },
}

export default plugin
