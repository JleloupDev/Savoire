// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { useCallback, useEffect, useRef, useState } from 'react'
import { DockviewReact } from 'dockview'
import type { DockviewApi, DockviewReadyEvent, IDockviewPanelProps, DockviewDidDropEvent } from 'dockview'
import { DocumentView } from '@savoire/editor-core'
import type { EditorController } from '@savoire/editor-core'
import type { IVaultSyncSession } from '@savoire/application'
import { EditorContext, Toolbar, BubbleToolbar, TriggerOverlay } from '@savoire/editor-react'
import { pluginRegistry } from './pluginRegistry'
import type { Widget, FileTypeRegistry, IPluginLoader, VaultPlugin } from '@savoire/plugin-api'
import type { ICollaborativeText } from '@savoire/domain-index'
import type { WorkspaceManagerImpl } from '@savoire/workspace'
import type { VaultClient } from '@savoire/platform'
import type { DocumentDto, VaultSummary, AccountEntry } from './types'

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'])

// ─── Refs injected from EditorPage (always current, never stale) ───────────

export interface EditorAreaRefs {
  documents: React.MutableRefObject<DocumentDto[]>
  loadDocument: React.MutableRefObject<(doc: DocumentDto) => Promise<string>>
  refreshDocuments: React.MutableRefObject<() => Promise<DocumentDto[]>>
  selectedVault: React.MutableRefObject<VaultSummary | null>
  token: React.MutableRefObject<string | null>
  activeAccount: React.MutableRefObject<AccountEntry | null>
  vaultAPI: React.MutableRefObject<VaultClient | undefined>
  /** Session de synchronisation du vault actif, quel que soit le profil
   *  (serveur Savoire, EdgeSync, demain automerge-repo). C'est ELLE qui cree
   *  le CRDT d'un document : voir IVaultSyncSession. Undefined pour un
   *  document partage isole. */
  vaultSession: React.MutableRefObject<IVaultSyncSession | undefined>
  onControllerReady: React.MutableRefObject<(ctrl: EditorController | null) => void>
  /** File type registry — populated by plugins in onBeforeReady. */
  fileTypeRegistry: React.MutableRefObject<FileTypeRegistry | null>
  /** Default plugins active for all notes — populated in onBeforeReady. */
  defaultPlugins: React.MutableRefObject<VaultPlugin[]>
  /** Shared PluginAPIImpl created in onBeforeReady — passed to EditorCore to avoid
   *  reloading plugins on every tab open. */
  pluginAPI: React.MutableRefObject<import('@savoire/plugin-api').IEditorHostAPI | null>
  /** Markdown editor mode: source (CM6) or rich (internal rich editor). */
  markdownEditorMode: React.MutableRefObject<'source' | 'rich'>
  /** ContentIndexingService — indexes non-Markdown files via shadow documents. */
  contentIndexingService: React.MutableRefObject<import('@savoire/application').ContentIndexingService | null>
  /** Factory for per-document plugin loaders (note-scoped plugins). */
  createPluginLoader: () => IPluginLoader
  /** True when the active vault/document grants read-only access to the current user. */
  isReadOnly: React.MutableRefObject<boolean>
  /** Emit a CRDT text change to RealtimeIndexingService — wired by usePluginBootstrap. */
  onCrdtTextChange: React.MutableRefObject<((docId: string, text: ICollaborativeText) => void) | null>
}

interface EditorPanelParams {
  doc: DocumentDto
  refs: EditorAreaRefs
  vaultId: string
  userId: string
}

function DocumentPanelHost({
  doc,
  refs,
  vaultId,
  userId,
}: {
  doc: DocumentDto
  refs: EditorAreaRefs
  vaultId: string
  userId: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<DocumentView | null>(null)
  const unsubPluginLoadedRef = useRef<(() => void) | null>(null)
  const [modeTick, setModeTick] = useState(0)
  const [controller, setController] = useState<EditorController | null>(null)

  useEffect(() => {
    const onModeChanged = () => setModeTick(t => t + 1)
    window.addEventListener('markdown-editor-mode-changed', onModeChanged)
    return () => window.removeEventListener('markdown-editor-mode-changed', onModeChanged)
  }, [])

  useEffect(() => {
    const container = containerRef.current
    const fileTypeRegistry = refs.fileTypeRegistry.current
    const vault = refs.vaultAPI.current
    if (!container || !fileTypeRegistry || !vault) return

    void refs.loadDocument.current(doc).catch((err) => {
      console.error('[EditorArea] loadDocument error', err)
    })

    unsubPluginLoadedRef.current?.()
    unsubPluginLoadedRef.current = null

    // L'editeur ne fabrique plus le CRDT : c'est la session du vault qui le
    // cree et le synchronise, parce que certains protocoles (automerge-repo)
    // possedent le document. openDocument() est idempotent, donc sûr face aux
    // remontages d'effet (StrictMode, bascule de mode d'edition).
    const session = refs.vaultSession.current
    if (!session) console.warn('[Sync] aucune session de vault active, le document ne se synchronisera pas', doc.id)
    const crdt = session?.openDocument(doc.id)

    const view = new DocumentView({
      path: doc.path,
      container,
      vaultId,
      docId: doc.id,
      userId,
      vault,
      fileTypeRegistry,
      pluginAPI: refs.pluginAPI.current ?? undefined,
      defaultPlugins: refs.defaultPlugins.current,
      pluginRegistry,
      crdt,
      getTransportState: () => session?.getState() ?? 'disconnected',
      editorMode: refs.markdownEditorMode.current,
      readOnly: refs.isReadOnly.current,
      createPluginLoader: refs.createPluginLoader,
      onFileContentStabilized: (docId, path, shadowMarkdown) => {
        void refs.contentIndexingService.current?.indexNow(docId, path, shadowMarkdown)
      },
    })
    view.mount()
    const unsubCrdtIndex = crdt?.onTextChange((text) => refs.onCrdtTextChange.current?.(doc.id, text))
    viewRef.current = view

    const ctrl = view.controller
    setController(ctrl)
    refs.onControllerReady.current(ctrl)
    if (ctrl) {
      unsubPluginLoadedRef.current = ctrl.on('pluginLoaded', () => {
        const current = viewRef.current?.controller
        if (current) {
          setController(current)
          refs.onControllerReady.current(current)
        }
      })
    }

    return () => {
      unsubPluginLoadedRef.current?.()
      unsubPluginLoadedRef.current = null
      unsubCrdtIndex?.()
      session?.closeDocument(doc.id)
      view.destroy()
      if (viewRef.current === view) viewRef.current = null
      setController(null)
      refs.onControllerReady.current(null)
    }
  }, [doc.id, doc.path, refs, userId, vaultId, modeTick])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    const vault = refs.vaultAPI.current
    const ctrl = viewRef.current?.controller
    if (!vault?.uploadAttachment || !ctrl) return

    e.preventDefault()
    const files = Array.from(e.dataTransfer.files).filter(f => {
      const ext = f.name.split('.').at(-1)?.toLowerCase() ?? ''
      return IMAGE_EXTS.has(ext)
    })

    for (const file of files) {
      try {
        const path = await vault.uploadAttachment(file)
        ctrl.insertText(`![[${path}]]`)
      } catch (err) {
        console.error('[EditorArea] image upload error', err)
      }
    }
  }, [refs])

  const isMarkdown = (doc.path.split('.').pop()?.toLowerCase() ?? '') === 'md'
  const showCm6Ui = isMarkdown && refs.markdownEditorMode.current === 'source' && !!controller

  return (
    <EditorContext.Provider value={controller}>
      <div
        style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
        onDragOver={e => e.preventDefault()}
        onDrop={e => void handleDrop(e)}
      >
        {showCm6Ui && <Toolbar />}
        <div ref={containerRef} style={{ flex: 1, minHeight: 0, overflow: 'auto' }} />
      </div>
      {showCm6Ui && <BubbleToolbar />}
      {showCm6Ui && <TriggerOverlay />}
    </EditorContext.Provider>
  )
}

function PanelDispatcher(props: IDockviewPanelProps<EditorPanelParams>) {
  const { doc, refs, vaultId, userId } = props.params
  return <DocumentPanelHost doc={doc} refs={refs} vaultId={vaultId} userId={userId} />
}

// ─── EditorAreaPanel ──────────────────────────────────────────────────────────

function EditorAreaPanel({
  manager,
  refs,
}: {
  manager: WorkspaceManagerImpl
  refs: EditorAreaRefs
}) {
  const dockviewRef = useRef<DockviewApi | null>(null)
  const pendingOpenPathsRef = useRef<string[]>([])
  // Guards against two near-simultaneous calls for the SAME path both racing
  // past the Dockview panel-existence check before either has reached
  // addPanel() — panelId/doc.id is only known after an async lookup
  // (refreshDocuments / vaultAPI fallback below), so the check can't happen
  // synchronously at entry.
  const pendingOpensRef = useRef<Set<string>>(new Set())
  const [openError, setOpenError] = useState<string | null>(null)
  // Force le re-rendu sur notifyVaultChange : `vault` est lu depuis un ref
  // (non reactif) plus bas. NE PAS remettre ce compteur dans la key de
  // DockviewReact : il change a chaque creation de note, et une key qui change
  // detruit puis remonte le composant, donc ferme tous les editeurs ouverts.
  const [, bumpVaultTick] = useState(0)

  // Vider la zone centrale quand on CHANGE de vault.
  //
  // notifyVaultChange() est un signal « quelque chose a bouge dans le vault »,
  // emis aussi bien par un changement de vault que par la creation, le
  // renommage ou la suppression d'une note. Le prendre pour « on a change de
  // vault » fermait tous les editeurs ouverts a chaque nouvelle note.
  // On compare donc l'id du vault, et on ne vide que s'il a reellement change.
  const lastVaultIdRef = useRef<string | null>(refs.selectedVault.current?.id ?? null)
  useEffect(() => {
    return manager.subscribeVaultChange?.(() => {
      bumpVaultTick(v => v + 1)
      const currentId = refs.selectedVault.current?.id ?? null
      if (currentId === lastVaultIdRef.current) return
      lastVaultIdRef.current = currentId
      pendingOpenPathsRef.current = []
      const api = dockviewRef.current
      if (!api) return
      for (const panel of [...api.panels]) {
        api.removePanel(panel)
      }
    })
  }, [manager, refs])

  async function openPathInCenter(path: string, referenceId?: string, dropPosition?: string, referenceIsGroup = false) {
    const vault = refs.selectedVault.current
    const token = refs.token.current
    const account = refs.activeAccount.current
    const api = dockviewRef.current
    if (!vault || !token || !account) return

    // Reserved synchronously, before any await: a second concurrent call for
    // the SAME path (e.g. two near-simultaneous openFile triggers right
    // after creating a note) would otherwise race this one through the
    // async doc/panelId resolution below and both reach addPanel() — the
    // panelId-based existence checks further down can't catch that, since
    // panelId itself isn't known until after the async gap.
    if (pendingOpensRef.current.has(path)) return
    pendingOpensRef.current.add(path)
    try {
      let doc = refs.documents.current.find(d => d.path === path || d.path === path + '.md')
      if (!doc) {
        const refreshed = await refs.refreshDocuments.current()
        doc = refreshed.find(d => d.path === path || d.path === path + '.md')
      }
      // see ADR-010
      if (!doc) {
        const meta = refs.vaultAPI.current?.documents.find(d => d.path === path || d.path === path + '.md')
        if (meta) {
          const now = new Date().toISOString()
          doc = { id: meta.id, path: meta.path, title: null, hash: '', sizeBytes: 0, createdAt: now, updatedAt: now }
        }
      }
      if (!doc) return

      const panelId = `doc-${doc.id}`

      const existing = api?.getPanel(panelId)
      if (existing) {
        existing.focus()
        manager.notifyActiveDocument(doc.path)
        return
      }

      const filename = doc.path.split('/').at(-1) ?? doc.path
      const title = doc.title?.trim() || filename.replace(/\.md$/, '') || doc.path
      try {
        const dirMap: Record<string, string> = {
          top: 'above', bottom: 'below', left: 'left', right: 'right', center: 'within',
        }
        const splitDir = dropPosition ? dirMap[dropPosition] : undefined
        api?.addPanel({
          id: panelId,
          component: 'doc-editor',
          title,
          params: {
            doc,
            refs,
            vaultId: vault.id,
            userId: account.userId,
          } satisfies EditorPanelParams,
          position: referenceId && splitDir
            ? referenceIsGroup
              ? { referenceGroup: referenceId, direction: splitDir as 'left' | 'right' | 'above' | 'below' | 'within' }
              : { referencePanel: referenceId, direction: splitDir as 'left' | 'right' | 'above' | 'below' | 'within' }
            : undefined,
        })
        setOpenError(null)
        manager.notifyActiveDocument(doc.path)
      } catch (err) {
        setOpenError(`Impossible d'ouvrir "${path}"`)
        console.error(err)
      }
    } finally {
      pendingOpensRef.current.delete(path)
    }
  }

  // Open a file as a Dockview tab (native drag/split/resize inside center pane)
  useEffect(() => {
    return manager.subscribeOpenFile(async (path: string) => {
      if (!dockviewRef.current) {
        pendingOpenPathsRef.current.push(path)
        return
      }
      await openPathInCenter(path)
    })
  }, [manager, refs])

  const vault = refs.selectedVault.current
  if (!vault) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-faint)', fontSize: '0.9rem' }}>
        Sélectionnez un vault.
      </div>
    )
  }

  return (
    <div className="editor-center-layout" style={{ height: '100%' }}>
      {openError && (
        <div style={{ fontSize: 12, color: 'var(--color-danger)', padding: '6px 10px', borderBottom: '1px solid var(--border)' }}>
          {openError}
        </div>
      )}
      <DockviewReact
        key={`vault-${vault.id}`}
        components={{ 'doc-editor': PanelDispatcher as React.FC<IDockviewPanelProps> }}
        onDidDrop={(e: DockviewDidDropEvent) => {
          const path = e.nativeEvent.dataTransfer?.getData('text/x-poc-file-path')
          if (!path) return
          // e.position is 'top'|'bottom'|'left'|'right'|'center' (dockview Position)
          // addPanel direction is 'above'|'below'|'left'|'right'|'within' (dockview Direction)
          const panelId = e.panel?.id
          const groupId = e.group?.api.id
          void openPathInCenter(path, panelId ?? groupId, e.position as string, !panelId && !!groupId)
        }}
        onReady={(event: DockviewReadyEvent) => {
          dockviewRef.current = event.api
          event.api.onUnhandledDragOverEvent((e) => {
            if (e.nativeEvent.dataTransfer?.types.includes('text/x-poc-file-path')) {
              e.accept()
            }
          })
          // Notify workspace when the active tab changes (tab switch or new panel)
          event.api.onDidActivePanelChange((panel) => {
            const params = panel?.params as EditorPanelParams | undefined
            if (params?.doc?.path) manager.notifyActiveDocument(params.doc.path)
          })
          const queued = [...pendingOpenPathsRef.current]
          pendingOpenPathsRef.current = []
          void Promise.all(queued.map((path) => openPathInCenter(path)))
        }}
      />
    </div>
  )
}

// ─── Widget wrapper ───────────────────────────────────────────────────────────

export class EditorAreaWidget implements Widget {
  constructor(
    private readonly manager: WorkspaceManagerImpl,
    private readonly refs: EditorAreaRefs,
  ) {}

  render() {
    return <EditorAreaPanel manager={this.manager} refs={this.refs} />
  }

  dispose() {}
}
