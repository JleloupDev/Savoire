// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { useRef, useCallback } from 'react'
import type { MutableRefObject } from 'react'
import type { WorkspaceManagerImpl } from '@savoire/workspace'
import { createFileTreePlugin } from '@savoire/plugin-filetree'
import { createVaultBrowserPlugin, type VaultBrowserRefs } from '@savoire/plugin-vault-browser'
import excalidrawPlugin from '@savoire/plugin-excalidraw'
import mindmapPlugin from '@savoire/plugin-mindmap'
import calloutPlugin from '@savoire/plugin-callout'
import codeBlockPlugin from '@savoire/plugin-code-block'
import taskListPlugin from '@savoire/plugin-task-list'
import noteEmbedPlugin from '@savoire/plugin-note-embed'
import { createWikilinksPlugin } from '@savoire/plugin-wikilinks'
import modulePlugin from '@savoire/plugin-module'
import mermaidPlugin from '@savoire/plugin-mermaid'
import tablePlugin from '@savoire/plugin-table'
import { createHashtagsPlugin } from '@savoire/plugin-hashtags'
import { createMetadataPlugin } from '@savoire/plugin-metadata'
import { createGraphPlugin } from '@savoire/plugin-graph'
import type { VaultAPI, VaultPlugin, IEditorHostAPI } from '@savoire/plugin-api'
import {
  BlockRegistryImpl,
  CommandRegistryImpl,
  FileTypeRegistryImpl,
  HookRegistryImpl,
  IndexRegistryImpl,
  SlashRegistryImpl,
  TriggerRegistryImpl,
  ToolbarCommandRegistryImpl,
  PluginAPIImpl,
  PluginLoader,
} from '@savoire/plugin-runtime'
import { ContentIndexingService, FilenameIndexContributor } from '@savoire/application'
import { InMemoryIndexStorage } from '@savoire/platform'
import type { EditorController } from '@savoire/editor-core'
import type { GraphIndexContributor } from '@savoire/plugin-graph'
import { EditorAreaWidget } from './EditorAreaWidget'
import type { EditorAreaRefs } from './EditorAreaWidget'
import { PluginInspectorWidget } from './PluginInspectorWidget'
import type { VaultSummary } from './types'
import type { DocumentRoomClient } from '@savoire/infrastructure-sync'

interface PluginBootstrapOptions {
  /** The shared DocumentRoomClient instance (stable, created once). */
  roomClient: DocumentRoomClient
  /** Stable VaultAPI proxy that always delegates to the active vault. */
  vaultProxy: VaultAPI
  /** Ref to the WorkspaceManagerImpl — populated by WorkspaceRoot.onReady. */
  managerRef: MutableRefObject<WorkspaceManagerImpl | null>
  /** Refs consumed by VaultBrowserPlugin (vault list + CRUD handlers). */
  vaultBrowserRefs: VaultBrowserRefs<VaultSummary>
  /**
   * Populated by EditorPage after this hook runs (but before onBeforeReady fires).
   * Holds the full EditorAreaRefs bag, assembled from vault refs + plugin refs returned here.
   */
  editorAreaRefsHolder: MutableRefObject<EditorAreaRefs | null>
}

export interface PluginBootstrapResult {
  /** Pass to WorkspaceRoot.onBeforeReady — registers views and loads all plugins. */
  onBeforeReady: (manager: WorkspaceManagerImpl) => Promise<void>
  pluginAPIRef: MutableRefObject<IEditorHostAPI | null>
  defaultPluginsRef: MutableRefObject<VaultPlugin[]>
  fileTypeRegistryRef: MutableRefObject<InstanceType<typeof FileTypeRegistryImpl> | null>
  /** Always-current callback: notify inspector whenever an editor gains/loses focus. */
  onControllerReadyRef: MutableRefObject<(ctrl: EditorController | null) => void>
  contentIndexingServiceRef: MutableRefObject<ContentIndexingService | null>
  graphContributorRef: MutableRefObject<GraphIndexContributor | null>
  pluginLoaderRef: MutableRefObject<PluginLoader>
  triggersRef: MutableRefObject<InstanceType<typeof TriggerRegistryImpl> | null>
}

/**
 * Owns all plugin-system state and the onBeforeReady bootstrap sequence.
 *
 * Plugins are loaded exactly once per session (see ADR-012).
 * The hook exposes the resulting refs so EditorPage can wire them into
 * EditorAreaRefs and pass them to child panels.
 */
export function usePluginBootstrap({
  roomClient,
  vaultProxy,
  managerRef,
  vaultBrowserRefs,
  editorAreaRefsHolder,
}: PluginBootstrapOptions): PluginBootstrapResult {
  const pluginAPIRef = useRef<IEditorHostAPI | null>(null)
  const pluginLoaderRef = useRef(new PluginLoader())
  const defaultPluginsRef = useRef<VaultPlugin[]>([])
  const pluginsBootstrappedRef = useRef(false)
  const pluginsBootstrapPromiseRef = useRef<Promise<void> | null>(null)
  const indexRegistryRef = useRef<IndexRegistryImpl | null>(null)
  const contentIndexingServiceRef = useRef<ContentIndexingService | null>(null)
  const graphContributorRef = useRef<GraphIndexContributor | null>(null)
  const triggersRef = useRef<InstanceType<typeof TriggerRegistryImpl> | null>(null)
  const fileTypeRegistryRef = useRef<InstanceType<typeof FileTypeRegistryImpl> | null>(null)

  // Always-current: notifies the inspector panel whenever an editor becomes active.
  // Reassigned each render so it always closes over fresh refs.
  const onControllerReadyRef = useRef<(ctrl: EditorController | null) => void>(() => {})
  onControllerReadyRef.current = (ctrl: EditorController | null) => {
    if (!managerRef.current) return
    const activeEditorPlugins: Array<{ id: string; source: 'default' | 'extension' | 'frontmatter' }> =
      ctrl?.getActivePlugins?.() ?? []
    const activeEditorIds = new Set(activeEditorPlugins.map(p => p.id))
    const defaultEditorIds = new Set(defaultPluginsRef.current.map(p => p.manifest.id))
    const workspacePlugins = pluginLoaderRef.current.getLoadedIds()
      .filter(id => !defaultEditorIds.has(id))
      .map(id => ({ id, source: 'workspace' as const }))
    const inactiveEditorPlugins = defaultPluginsRef.current
      .filter(p => !activeEditorIds.has(p.manifest.id))
      .map(p => ({ id: p.manifest.id, source: 'inactive' as const }))
    managerRef.current.notifyActiveEditor({
      filePath: ctrl?.getActiveFile?.() ?? null,
      plugins: [...activeEditorPlugins, ...inactiveEditorPlugins, ...workspacePlugins],
    })
  }

  const onBeforeReady = useCallback(async (manager: WorkspaceManagerImpl) => {
    const editorAreaRefs = editorAreaRefsHolder.current
    if (!editorAreaRefs) {
      console.error('[usePluginBootstrap] editorAreaRefsHolder was not populated before onBeforeReady fired')
      return
    }

    // Register permanent workspace views
    manager.views.register({
      id: 'editor-area',
      title: 'Éditeur',
      container: 'center',
      closable: false,
      createView: (_ctx: unknown) => new EditorAreaWidget(manager, editorAreaRefs),
    })
    manager.views.register({
      id: 'plugin-inspector',
      title: 'Plugins actifs',
      container: 'right',
      createView: (_ctx: unknown) => new PluginInspectorWidget(manager),
    })

    // Bootstrap plugins once per session (see ADR-012)
    if (!pluginAPIRef.current && !pluginsBootstrapPromiseRef.current) {
      const slash         = new SlashRegistryImpl()
      const triggers      = new TriggerRegistryImpl()
      const fileTypeRegistry = new FileTypeRegistryImpl()
      const indexRegistry = new IndexRegistryImpl()
      indexRegistry.register(new FilenameIndexContributor())
      indexRegistryRef.current = indexRegistry

      const pluginApi = new PluginAPIImpl(
        new BlockRegistryImpl(slash),
        new HookRegistryImpl(),
        new CommandRegistryImpl(),
        fileTypeRegistry,
        vaultProxy,
        manager,
        manager.views,
        slash,
        triggers,
        new ToolbarCommandRegistryImpl(),
        undefined, // editor position API — wired later by EditorCore
        roomClient,
        indexRegistry,
      )

      // ContentIndexingService: wires hooks → contributors → storage.
      contentIndexingServiceRef.current = new ContentIndexingService(
        pluginApi.hooks,
        indexRegistry,
        new InMemoryIndexStorage(),
      )

      // TEMPORARY: register Markdown as a native file type so the file tree and
      // creation picker are aware of it before any plugin loads. A better solution
      // is needed — EditorCore should declare its capabilities through a dedicated
      // mechanism rather than being bootstrapped here.
      fileTypeRegistry.register({
        extension: 'md',
        label: 'Note Markdown',
        icon: '📝',
        creatable: true,
        create: async () => '',
        // No open() — EditorCore handles .md files directly via DocumentView.
      })

      // Important: set shared API immediately to avoid races with concurrent onBeforeReady calls.
      pluginAPIRef.current = pluginApi
      triggersRef.current = triggers
      fileTypeRegistryRef.current = fileTypeRegistry

      // see ADR-012
      defaultPluginsRef.current = [
        mermaidPlugin, calloutPlugin, codeBlockPlugin,
        noteEmbedPlugin, modulePlugin, taskListPlugin, tablePlugin,
      ]

      pluginsBootstrapPromiseRef.current = (async () => {
        await pluginLoaderRef.current.loadInternal(createVaultBrowserPlugin({
          refs: vaultBrowserRefs,
          container: 'left',
          initialSize: 260,
          closable: false,
        }), pluginApi)
        await pluginLoaderRef.current.loadInternal(createFileTreePlugin({
          container: 'left',
          belowOf: 'vault-browser',
          closable: false,
        }), pluginApi)
        // Right pane: top = Plugin inspector + Metadata, bottom = Backlinks + Hashtags + Graph
        await pluginLoaderRef.current.loadInternal(createWikilinksPlugin({
          belowOf: 'plugin-inspector',
        }), pluginApi)
        await pluginLoaderRef.current.loadInternal(createHashtagsPlugin({
          tabOf: 'backlinks',
        }), pluginApi)
        await pluginLoaderRef.current.loadInternal(createMetadataPlugin({
          tabOf: 'plugin-inspector',
        }), pluginApi)
        const { plugin: graphPlugin, contributor: graphContributor } = createGraphPlugin({
          tabOf: 'backlinks',
        })
        graphContributorRef.current = graphContributor
        await pluginLoaderRef.current.loadInternal(graphPlugin, pluginApi)
        // excalidraw and mindmap register FileTypeSpec in the workspace API (file-type handlers).
        await pluginLoaderRef.current.loadInternal(excalidrawPlugin, pluginApi)
        await pluginLoaderRef.current.loadInternal(mindmapPlugin, pluginApi)
        // Editor plugins — blocks, hooks, slash commands (shared across all tabs).
        for (const plugin of defaultPluginsRef.current) {
          await pluginLoaderRef.current.loadInternal(plugin, pluginApi)
        }
        // Register EditorCore built-in trigger so it appears in Settings
        triggers.register({ id: 'slash-command', character: '/', description: 'Palette de commandes' })
        pluginsBootstrappedRef.current = true

        contentIndexingServiceRef.current?.setOnIndexed((docId, path) => {
          managerRef.current?.notifyDocumentIndexed(docId, path)
        })
        contentIndexingServiceRef.current?.init()
      })()
    }

    if (pluginsBootstrapPromiseRef.current) await pluginsBootstrapPromiseRef.current
    const shared = pluginAPIRef.current
    if (shared) {
      triggersRef.current = shared.triggers as TriggerRegistryImpl
      fileTypeRegistryRef.current = shared.files as FileTypeRegistryImpl
    }
  }, [vaultBrowserRefs, vaultProxy, editorAreaRefsHolder, roomClient, managerRef])

  return {
    onBeforeReady,
    pluginAPIRef,
    defaultPluginsRef,
    fileTypeRegistryRef,
    onControllerReadyRef,
    contentIndexingServiceRef,
    graphContributorRef,
    pluginLoaderRef,
    triggersRef,
  }
}
