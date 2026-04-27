// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { EditorView, keymap } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import * as Y from 'yjs'
import { yCollab } from 'y-codemirror.next'
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness'
import { HubConnectionBuilder, HubConnection, HubConnectionState, HttpTransportType, LogLevel } from '@microsoft/signalr'

import type { EditorController, EditorCoreOptions, EditorEvent, MarkdownFormat, SelectionCoords, TriggerActivation, ToolbarCommand } from './types'
import type { EditorCommandContext, EditorPositionAPI, NoteScope, NotePluginScope, IEditorHostAPI, IPluginLoader } from '@savoire/plugin-api'
import { resolveActivePlugins } from './PluginActivationResolver'
import type { ActivationEntry } from './PluginActivationResolver'
import { toggleMarkdownFormat } from './FormattingService'
import { EventBus } from './EventBus'
import { CommandRegistry, type CommandContext } from './CommandRegistry'
import { DocumentPipeline } from './DocumentPipeline'
import { createLivePreviewExtension, pluginsLoadedEffect, setRemoteCursorPositions } from './LivePreview'

// Detects a list item line: optional leading whitespace + bullet or ordered marker
const LIST_LINE_RE = /^(\s*)([-*+]|\d+\.) /

const LONE_SYMBOL_RE = /^(#{1,6}|[-*+]|>)\s*$/

function indentListLine(view: EditorView): boolean {
  const { state } = view
  const line = state.doc.lineAt(state.selection.main.head)
  if (!LIST_LINE_RE.test(line.text)) return false
  const anchor = state.selection.main.anchor + 2
  view.dispatch(state.update({ changes: { from: line.from, insert: '  ' }, selection: { anchor } }))
  return true
}

function dedentListLine(view: EditorView): boolean {
  const { state } = view
  const line = state.doc.lineAt(state.selection.main.head)
  const match = line.text.match(/^(\s+)([-*+]|\d+\.) /)
  if (!match || match[1].length < 2) return false
  const newAnchor = Math.max(line.from, state.selection.main.anchor - 2)
  view.dispatch(state.update({ changes: { from: line.from, to: line.from + 2, insert: '' }, selection: { anchor: newAnchor } }))
  return true
}

// see ADR-004
function userColor(userId: string): string {
  let h = 0
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) >>> 0
  return `hsl(${h % 360}, 70%, 50%)`
}

// ── Noop host API — used when no PluginAPIImpl is provided (standalone / playground) ──

function createNoopHostAPI(): IEditorHostAPI {
  // Used when no PluginAPIImpl is provided (standalone / playground mode).
  // Real usage always passes PluginAPIImpl from usePluginBootstrap.
  const noop = () => {}
  const noopAsync = async (s: string) => s
  const emptyReg = { register: noop, unregister: noop, getAll: () => [] as never[] }
  return {
    // PluginAPI fields (IEditorHostAPI extends PluginAPI)
    commands: emptyReg,
    hooks: {
      beforeParse: noop, afterParse: noop, beforeRender: noop, afterRender: noop,
      onDocumentOpen: noop, onDocumentSave: noop, onSelectionChange: noop, onDocumentStabilized: noop,
      runBeforeParse: noopAsync, runBeforeParseSync: (s) => s,
      runAfterRender: noopAsync, runDocumentOpen: noop,
      runDocumentSave: noop, runDocumentStabilized: noop,
    },
    blocks: {
      ...emptyReg,
      detectBlock: () => null, getActive: () => [], detectActive: () => null,
    },
    files: { register: noop, unregister: noop, resolve: () => undefined, getAll: () => [] },
    vault: {
      read: async () => '', readDocumentByPath: async () => '',
      write: async () => {}, list: async () => [],
      exists: async () => false, resolveDocumentId: () => undefined,
    },
    workspace: {
      openFile: async () => {}, openPanel: noop, closePanel: noop,
      getActiveDocument: () => undefined,
    },
    views: emptyReg,
    slash: emptyReg,
    triggers: { ...emptyReg, findConflict: () => undefined },
    editor: { getCursorCoords: () => null, getSelectionCoords: () => null, getSelectionText: () => '' },
    toolbar: { ...emptyReg, getByGroup: () => [] },
    // IEditorHostAPI-specific
    setEditorPositionAPI: noop,
  }
}

// ── Noop plugin loader — used when no factory is injected (standalone / playground) ──

function createNoopPluginLoader(): IPluginLoader {
  return {
    loadInternal: async () => {},
    getLoadedIds: () => [],
  }
}

// ── Note-scope helpers ────────────────────────────────────────────────────

function parseScopeFromContent(content: string): NoteScope {
  // see ADR-007
  const normalised = content.replace(/\r\n/g, '\n')
  const match = normalised.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return {}
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx <= 0) continue
    const key = line.slice(0, colonIdx).trim()
    if (key !== 'plugins') continue
    const value = line.slice(colonIdx + 1).trim()
    if (!value) continue
    const plugins: NotePluginScope[] = value.split(',').map(entry => {
      const parts = entry.trim().split(':')
      const id = parts[0].trim()
      const load = parts[1]?.trim() as NotePluginScope['load'] | undefined
      return { id, load: (load === 'lazy' ? 'lazy' : 'auto') as import('@savoire/plugin-api').PluginLoadStrategy }
    }).filter(p => p.id.length > 0)
    return { plugins }
  }
  return {}
}

const EXT_PLUGIN_IDS: Record<string, string> = {
  'excalidraw': 'plugin-excalidraw',
  'mm':         'plugin-mindmap',
}

async function loadScopedPlugin(
  pluginId: string,
  registry: Record<string, () => Promise<import('@savoire/plugin-api').VaultPlugin>>,
  loader: IPluginLoader,
  api: IEditorHostAPI,
): Promise<void> {
  const factory = registry[pluginId]
  if (!factory) {
    console.warn(`[NoteScope] plugin "${pluginId}" not in pluginRegistry — skipped`)
    return
  }
  console.log(`[NoteScope] loading "${pluginId}"…`)
  try {
    const plugin = await factory()
    await loader.loadInternal(plugin, api)
    console.log(`[NoteScope] ✓ "${pluginId}" loaded`)
  } catch (err) {
    console.warn(`[NoteScope] failed to load "${pluginId}":`, err)
  }
}

export class EditorCore implements EditorController, EditorPositionAPI {
  private view: EditorView
  private ydoc: Y.Doc
  private awareness: Awareness
  private connection: HubConnection | null = null
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private destroyed = false
  private events = new EventBus()
  private activeFile: string | null = null

  // ── Reactive scope state ──────────────────────────────────────────────────
  // see ADR-012
  private defaultActiveIds: Set<string> = new Set()
  private physicallyLoadedIds = new Set<string>()
  private loadedScopedPlugins = new Map<string, 'extension' | 'frontmatter'>()
  private activationMap = new Map<string, ActivationEntry>()
  private pluginLoader: IPluginLoader | null = null
  private scopeDebounceTimer: ReturnType<typeof setTimeout> | null = null
  // see ADR-006
  private stabilizeDebounceTimer: ReturnType<typeof setTimeout> | null = null

  readonly commands = new CommandRegistry()
  readonly pipeline = new DocumentPipeline()
  readonly pluginAPI: IEditorHostAPI

  constructor(private options: EditorCoreOptions) {
    const tConstruct = performance.now()
    console.log(`[perf] EditorCore constructor — docId=${options.docId ?? 'none'}`)
    this.activeFile = options.filePath ?? null
    // see ADR-008
    this.pluginAPI = options.pluginAPI ?? createNoopHostAPI()
    void (async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      console.log(`[perf] after setTimeout(0) — +${(performance.now() - tConstruct).toFixed(0)} ms (timer fired / still alive)`)
    })()
    this.ydoc = new Y.Doc()
    this.awareness = new Awareness(this.ydoc)
    const yText = this.ydoc.getText('codemirror')

    const userId = options.userId ?? 'anon'
    this.awareness.setLocalStateField('user', {
      name: userId,
      color: userColor(userId),
      colorLight: userColor(userId).replace('50%', '80%'),
    })

    const ctx = { editorView: null as unknown }

    // see ADR-004
    let lastCursorLine = -1

    const crdtMode = options.serverUrl !== undefined && options.serverUrl !== null
    const offlineDoc = crdtMode ? '' : (options.initialContent ?? '')
    const startState = EditorState.create({
      doc: offlineDoc,
      selection: crdtMode ? undefined : { anchor: offlineDoc.length },
      extensions: [
        ...(options.readOnly
          ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
          : [
              history(),
              keymap.of([
                { key: 'Tab', run: indentListLine },
                { key: 'Shift-Tab', run: dedentListLine, preventDefault: true },
                ...defaultKeymap,
                ...historyKeymap,
              ]),
            ]
        ),
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(defaultHighlightStyle),
        yCollab(yText, this.awareness),
        ...createLivePreviewExtension(this.pluginAPI.blocks, this.pluginAPI.hooks, ctx, options.showLineNumbers ?? true, () => new Set(this.activationMap.keys())),
        ...(options.readOnly ? [EditorView.theme({
          '&': { height: 'auto' },
          '.cm-scroller': { overflow: 'visible' },
        })] : []),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            this.events.emit('documentChanged', update)

            // see ADR-006
            if (this.scopeDebounceTimer !== null) clearTimeout(this.scopeDebounceTimer)
            this.scopeDebounceTimer = setTimeout(() => {
              this.scopeDebounceTimer = null
              this.recheckScope(update.state.doc.toString())
            }, 1000)

            // see ADR-015
            if (this.stabilizeDebounceTimer !== null) clearTimeout(this.stabilizeDebounceTimer)
            this.stabilizeDebounceTimer = setTimeout(() => {
              this.stabilizeDebounceTimer = null
              const content = update.view.state.doc.toString()
              const docId = this.options.docId ?? ''
              const path  = this.activeFile ?? ''
              let clock = 0
              for (const c of Y.decodeStateVector(Y.encodeStateVector(this.ydoc)).values()) clock += c
              this.pluginAPI.hooks.runDocumentStabilized(docId, path, content, { clock })
            }, 2000)
          }
          if (update.selectionSet) {
            this.events.emit('selectionChanged', update)
          }

          const curLine = update.state.doc.lineAt(update.state.selection.main.head).number
          // Always track cursor line (even during selection) so we know where to clean up
          // when the selection collapses.
          const lineChanged = curLine !== lastCursorLine
          const prevLine = lastCursorLine
          lastCursorLine = curLine
          if (update.state.selection.main.empty && lineChanged) {
            if (prevLine > 0 && prevLine <= update.state.doc.lines) {
              const line = update.state.doc.line(prevLine)
              if (LONE_SYMBOL_RE.test(line.text)) {
                queueMicrotask(() => {
                  const state = update.view.state
                  if (prevLine > state.doc.lines) return
                  const l = state.doc.line(prevLine)
                  if (!LONE_SYMBOL_RE.test(l.text)) return
                  update.view.dispatch({
                    changes: { from: l.from, to: l.to, insert: '' },
                    userEvent: 'delete.auto-clean',
                  })
                })
              }
            }
          }
        }),
      ],
    })

    this.view = new EditorView({
      state: startState,
      parent: options.container,
    })

    // Update ctx.editorView now that the view exists
    ctx.editorView = this.view

    // Wire EditorCore as the real EditorPositionAPI so plugins can call editor.getCursorCoords() etc.
    this.pluginAPI.setEditorPositionAPI(this)

    this.loadPlugins()

    // see ADR-025
    // see ADR-009
    if (options.serverUrl !== undefined && options.serverUrl !== null) {
      this.connectTimer = setTimeout(() => {
        this.connectTimer = null
        void this.connectSignalR()
      }, 0)
    }
  }

  private async loadPlugins(): Promise<void> {
    this.registerBuiltins()

    this.pluginLoader = this.options.createPluginLoader?.() ?? createNoopPluginLoader()
    const loader = this.pluginLoader

    // see ADR-008
    if (!this.options.pluginAPI) {
      for (const plugin of (this.options.defaultPlugins ?? [])) {
        await loader.loadInternal(plugin, this.pluginAPI)
      }
    }
    // Derive defaultActiveIds from manifests — used by resolveActivePlugins().
    this.defaultActiveIds = new Set(
      (this.options.defaultPlugins ?? [])
        .filter(p => p.manifest.defaultActive)
        .map(p => p.manifest.id),
    )

    // ── Note-scoped plugins ────────────────────────────────────────────────
    const registry = this.options.pluginRegistry ?? {}

    const ext = this.options.filePath?.split('.').pop()?.toLowerCase()
    const extPluginId = ext ? EXT_PLUGIN_IDS[ext] : undefined
    if (extPluginId && !this.physicallyLoadedIds.has(extPluginId)) {
      await this.activateScopedPlugin(extPluginId, 'extension', registry, loader)
    }

    // Parse scope from options (explicit) or from initialContent frontmatter (auto).
    const scope = this.options.scope ?? parseScopeFromContent(this.options.initialContent ?? '')
    if (scope.plugins && scope.plugins.length > 0) {
      const autoPlugins = scope.plugins.filter(p => (p.load ?? 'auto') === 'auto')
      const lazyPlugins = scope.plugins.filter(p => p.load === 'lazy')

      for (const p of autoPlugins) {
        await this.activateScopedPlugin(p.id, 'frontmatter', registry, loader)
      }

      if (lazyPlugins.length > 0) {
        const idle = typeof requestIdleCallback !== 'undefined' ? requestIdleCallback : setTimeout
        idle(async () => {
          for (const p of lazyPlugins) {
            await this.activateScopedPlugin(p.id, 'frontmatter', registry, loader)
          }
          this.rebuildActivation()
          this.events.emit('pluginLoaded')
          this.view.dispatch({ effects: pluginsLoadedEffect.of(undefined) })
        })
      }
    }

    console.log(`[NoteScope] active scoped plugins: [${[...this.loadedScopedPlugins.keys()].join(', ') || 'none'}]`)

    // see ADR-012
    this.rebuildActivation()
    this.events.emit('pluginLoaded')

    // Trigger a decoration rebuild now that all auto plugins are registered.
    this.view.dispatch({ effects: pluginsLoadedEffect.of(undefined) })
  }

  // see ADR-012
  private async activateScopedPlugin(
    pluginId: string,
    source: 'extension' | 'frontmatter',
    registry: Record<string, () => Promise<import('@savoire/plugin-api').VaultPlugin>>,
    loader: IPluginLoader,
  ): Promise<boolean> {
    if (!this.physicallyLoadedIds.has(pluginId)) {
      const alreadyInSharedAPI = this.options.pluginAPI !== undefined &&
        (this.options.defaultPlugins ?? []).some(p => p.manifest.id === pluginId)
      if (alreadyInSharedAPI) {
        console.log(`[NoteScope] activating "${pluginId}" (${source}) — already in shared API`)
      } else {
        // Bail out if not in registry — don't add to activation map
        if (!registry[pluginId]) {
          console.warn(`[NoteScope] plugin "${pluginId}" not in pluginRegistry — skipped`)
          return false
        }
        await loadScopedPlugin(pluginId, registry, loader, this.pluginAPI)
      }
      this.physicallyLoadedIds.add(pluginId)
    }
    this.loadedScopedPlugins.set(pluginId, source)
    return true
  }

  // see ADR-012
  private rebuildActivation(): void {
    this.activationMap = resolveActivePlugins({
      defaultActiveIds: this.defaultActiveIds,
      extPluginMap: EXT_PLUGIN_IDS,
      filePath: this.options.filePath ?? null,
      loadedScopedPlugins: this.loadedScopedPlugins,
    })
  }

  // see ADR-006
  private async recheckScope(content: string): Promise<void> {
    if (!this.pluginLoader) return
    const scope = parseScopeFromContent(content)

    // Replace frontmatter activations entirely
    for (const [id, src] of this.loadedScopedPlugins) {
      if (src === 'frontmatter') this.loadedScopedPlugins.delete(id)
    }

    if (scope.plugins && scope.plugins.length > 0) {
      const registry = this.options.pluginRegistry ?? {}
      const autoPlugins = scope.plugins.filter(p => (p.load ?? 'auto') === 'auto')
      const lazyPlugins = scope.plugins.filter(p => p.load === 'lazy')

      for (const p of autoPlugins) {
        await this.activateScopedPlugin(p.id, 'frontmatter', registry, this.pluginLoader!)
      }

      if (lazyPlugins.length > 0) {
        const idle = typeof requestIdleCallback !== 'undefined' ? requestIdleCallback : setTimeout
        idle(async () => {
          for (const p of lazyPlugins) {
            await this.activateScopedPlugin(p.id, 'frontmatter', registry, this.pluginLoader!)
          }
          this.rebuildActivation()
          this.events.emit('pluginLoaded')
          this.view.dispatch({ effects: pluginsLoadedEffect.of(undefined) })
        })
      }
    }

    this.rebuildActivation()
    this.events.emit('pluginLoaded')
    this.view.dispatch({ effects: pluginsLoadedEffect.of(undefined) })
  }

  private registerBuiltins(): void {
    const { slash, triggers, toolbar } = this.pluginAPI

    // Register / as a trigger with a handler that reads from the slash registry.
    triggers.register({
      id: 'slash-command',
      character: '/',
      description: 'Palette de commandes',
      handler: {
        getItems: (query: string) => {
          const all = slash.getAll()
          const filtered = !query ? all : all.filter(item => {
            const q = query.toLowerCase()
            return item.label.toLowerCase().includes(q) || item.description?.toLowerCase().includes(q)
          })
          // Adapt SlashCommandItem to TriggerItem (normalize insert signature)
          return filtered.map(item => ({
            id: item.id,
            label: item.label,
            icon: item.icon,
            category: item.category,
            description: item.description,
            insert: typeof item.insert === 'function'
              ? (q: string) => (item.insert as (ctx: { query: string }) => string)({ query: q })
              : item.insert,
          }))
        },
        // no onCommit — default commitTriggerInsert is used
      },
    })

    const builtins = [
      { id: 'builtin-h1',         label: 'Titre 1',         description: 'Grand titre (# )',         icon: 'H1',  category: 'Titres',  insert: '# '   },
      { id: 'builtin-h2',         label: 'Titre 2',         description: 'Titre moyen (## )',         icon: 'H2',  category: 'Titres',  insert: '## '  },
      { id: 'builtin-h3',         label: 'Titre 3',         description: 'Petit titre (### )',        icon: 'H3',  category: 'Titres',  insert: '### ' },
      { id: 'builtin-ul',         label: 'Liste à puces',   description: 'Liste non ordonnée (- )',   icon: '•',   category: 'Listes',  insert: '- '   },
      { id: 'builtin-ol',         label: 'Liste numérotée', description: 'Liste ordonnée (1. )',      icon: '1.',  category: 'Listes',  insert: '1. '  },
      { id: 'builtin-todo',       label: 'Case à cocher',   description: 'Liste de tâches (- [ ] )', icon: '☐',   category: 'Listes',  insert: '- [ ] ' },
      { id: 'builtin-blockquote', label: 'Citation',        description: 'Bloc de citation (> )',     icon: '"',   category: 'Blocs',   insert: '> '   },
      { id: 'builtin-code',       label: 'Bloc de code',    description: 'Bloc de code (```)',        icon: '</>',  category: 'Blocs',  insert: '```\n\n```' },
      { id: 'builtin-table',      label: 'Tableau',         description: 'Tableau Markdown',          icon: '⊞',   category: 'Blocs',   insert: '| Col 1 | Col 2 |\n| --- | --- |\n| | |' },
      { id: 'builtin-hr',         label: 'Séparateur',      description: 'Ligne horizontale (---)',   icon: '—',   category: 'Blocs',   insert: '---'  },
    ] as const
    for (const item of builtins) slash.register(item)

    // Toolbar commands — built-ins for common Markdown formatting
    const toolbarCmds = [
      { id: 'tb-bold',   label: 'Gras',        icon: 'B',    group: 'format', requiresSelection: true,  run: () => this.toggleFormat('bold')   },
      { id: 'tb-italic', label: 'Italique',    icon: 'I',    group: 'format', requiresSelection: true,  run: () => this.toggleFormat('italic') },
      { id: 'tb-strike', label: 'Barré',       icon: 'S',    group: 'format', requiresSelection: true,  run: () => this.toggleFormat('strike') },
      { id: 'tb-code',   label: 'Code inline', icon: '</>',  group: 'format', requiresSelection: false, run: () => this.toggleFormat('code')   },
      { id: 'tb-link',   label: 'Lien',        icon: '🔗',  group: 'insert', requiresSelection: false, run: () => this.toggleFormat('link')   },
      { id: 'tb-h1',     label: 'Titre 1',     icon: 'H1',   group: 'format', requiresSelection: false, run: () => this.toggleFormat('h1')    },
      { id: 'tb-h2',     label: 'Titre 2',     icon: 'H2',   group: 'format', requiresSelection: false, run: () => this.toggleFormat('h2')    },
    ]
    for (const cmd of toolbarCmds) toolbar.register(cmd)
  }

  private async connectSignalR() {
    const { serverUrl, vaultId = 'default', docId = 'default', userId = 'anon' } = this.options
    const t0 = performance.now()
    console.log(`[perf] connectSignalR start — docId=${docId}`)

    const { getToken } = this.options
    this.connection = new HubConnectionBuilder()
      .withUrl(`${serverUrl}/hubs/sync?userId=${encodeURIComponent(userId)}`, {
        transport: HttpTransportType.WebSockets,
        ...(getToken ? { accessTokenFactory: () => getToken() ?? '' } : {}),
      })
      .configureLogging(LogLevel.None)
      .withAutomaticReconnect()
      .build()

    this.connection.on('InitDocument', (_docId: string, ops: string[]) => {
      console.log(`[perf] InitDocument received — ${ops.length} ops — +${(performance.now() - t0).toFixed(0)} ms`)
      ops.forEach((op) => {
        const update = Uint8Array.from(atob(op), (c) => c.charCodeAt(0))
        Y.applyUpdate(this.ydoc, update)
      })
      console.log(`[perf] Yjs applied — +${(performance.now() - t0).toFixed(0)} ms`)
      requestAnimationFrame(() => {
        const v = this.view
        if (v && !v.hasFocus) {
          v.dispatch({ selection: { anchor: v.state.doc.length } })
        }
      })

      const COMPACT_THRESHOLD = 100
      if (ops.length > COMPACT_THRESHOLD && this.connection?.state === HubConnectionState.Connected) {
        const snapshot = Y.encodeStateAsUpdate(this.ydoc)
        const snapshotBase64 = btoa(String.fromCharCode(...snapshot))
        void this.connection.invoke('SnapshotDocument', vaultId, _docId, snapshotBase64)
          .then(() => console.log(`[perf] SnapshotDocument envoyé (${ops.length} ops → 1 snapshot)`))
          .catch(console.error)
      }
    })

    this.connection.on('ReceiveOperation', (_docId: string, _clientId: string, base64: string) => {
      const update = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      Y.applyUpdate(this.ydoc, update)
    })

    // Awareness: receive cursor states from other editors
    this.connection.on('AwarenessUpdated', (_docId: string, base64: string) => {
      const update = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      applyAwarenessUpdate(this.awareness, update, 'server')
      // Sync remote positions into CM6 so live preview does not replace blocks
      // that contain a peer's cursor.
      this.syncRemoteCursorsToView()
    })

    this.ydoc.on('update', (update: Uint8Array) => {
      // Only push if the connection is actually up — avoids spam when offline
      if (this.connection?.state !== HubConnectionState.Connected) return
      const base64 = btoa(String.fromCharCode(...update))
      this.connection
        .invoke('PushOperation', vaultId, docId, this.options.clientId ?? 'anon', base64)
        .catch(console.error)
    })

    // Awareness: send local cursor changes to other editors
    const awarenessHandler = ({ added, updated, removed }: { added: number[], updated: number[], removed: number[] }) => {
      if (this.connection?.state !== HubConnectionState.Connected) return
      const changed = [...added, ...updated, ...removed]
      const update = encodeAwarenessUpdate(this.awareness, changed)
      const base64 = btoa(String.fromCharCode(...update))
      this.connection.invoke('UpdateAwareness', vaultId, docId, base64).catch(console.error)
    }
    this.awareness.on('update', awarenessHandler)

    try {
      await this.connection.start()
      if (this.destroyed) return
      console.log(`[perf] WS connected — +${(performance.now() - t0).toFixed(0)} ms`)
      await this.connection.invoke('JoinDocument', vaultId, docId)
      if (this.destroyed) return
      console.log(`[perf] JoinDocument ack — +${(performance.now() - t0).toFixed(0)} ms`)
      // Immediately announce our local state to other peers.
      const initialUpdate = encodeAwarenessUpdate(this.awareness, [this.ydoc.clientID])
      const base64 = btoa(String.fromCharCode(...initialUpdate))
      void this.connection.invoke('UpdateAwareness', vaultId, docId, base64)
    } catch {
      if (!this.destroyed) console.debug('[EditorCore] SignalR unavailable — offline mode')
    }
  }

  async openFile(path: string): Promise<void> {
    this.activeFile = path
    this.events.emit('fileOpened', path)
  }

  async save(): Promise<void> {
    // Server auto-receives updates via CRDT — save is a no-op in collaborative mode.
    this.events.emit('fileSaved', this.activeFile)
  }

  executeCommand(id: string): void {
    const context: CommandContext = { view: this.view }
    this.commands.execute(id, context)
  }

  // see ADR-004
  toggleFormat(format: MarkdownFormat): void {
    toggleMarkdownFormat(this.view, format)
  }

  getActiveFile(): string | null {
    return this.activeFile
  }

  on(event: EditorEvent, handler: (...args: unknown[]) => void): () => void {
    return this.events.on(event, handler)
  }

  getConnectionStatus(): 'connected' | 'connecting' | 'disconnected' {
    if (!this.connection) return 'disconnected'
    switch (this.connection.state) {
      case HubConnectionState.Connected:    return 'connected'
      case HubConnectionState.Connecting:
      case HubConnectionState.Reconnecting: return 'connecting'
      default:                              return 'disconnected'
    }
  }

  exportMarkdown(): string {
    return this.view.state.doc.toString()
  }

  getSelectionCoords(): SelectionCoords | null {
    const { from, to } = this.view.state.selection.main
    if (from === to) return null
    const startCoords = this.view.coordsAtPos(from)
    const endCoords   = this.view.coordsAtPos(to)
    if (!startCoords || !endCoords) return null
    return {
      x: (startCoords.left + endCoords.right) / 2,
      y: startCoords.top,
    }
  }

  // ── EditorPositionAPI implementation ─────────────────────────────────────

  getCursorCoords(): { x: number; y: number } | null {
    const { from } = this.view.state.selection.main
    const coords = this.view.coordsAtPos(from)
    if (!coords) return null
    return { x: coords.left, y: coords.bottom }
  }

  getSelectionText(): string {
    const { from, to } = this.view.state.selection.main
    return this.view.state.doc.sliceString(from, to)
  }

  // ── Generic trigger system ────────────────────────────────────────────────

  getActiveTrigger(): TriggerActivation | null {
    const { state } = this.view
    const { from, to } = state.selection.main
    if (from !== to) return null
    const line = state.doc.lineAt(from)
    const textBefore = line.text.slice(0, from - line.from)

    // Check all registered triggers, longest match first
    const triggers = this.pluginAPI.triggers.getAll()
      .sort((a, b) => b.character.length - a.character.length)

    for (const trigger of triggers) {
      let match: RegExpMatchArray | null = null
      if (trigger.pattern) {
        match = textBefore.match(trigger.pattern)
      } else {
        // Default: character preceded by start-of-line or whitespace
        const escaped = trigger.character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const re = new RegExp(`(?:^|\\s)(${escaped}(\\S*))$`)
        match = textBefore.match(re)
      }
      if (!match) continue

      const charIdx = textBefore.lastIndexOf(trigger.character)
      const triggerPos = line.from + charIdx
      const coords = this.view.coordsAtPos(triggerPos)
      if (!coords) continue

      return {
        triggerId: trigger.id,
        character: trigger.character,
        query: trigger.pattern ? (match[1] ?? '') : (match[2] ?? ''),
        from: triggerPos,
        coords: { x: coords.left, y: coords.bottom },
        lineTop: coords.top,
      }
    }
    return null
  }

  commitTriggerInsert(from: number, triggerCharLen: number, query: string, insert: string): void {
    const to = from + triggerCharLen + query.length
    this.view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length },
    })
    this.view.focus()
  }

  insertText(text: string): void {
    const anchor = this.view.state.selection.main.head
    this.view.dispatch({
      changes: { from: anchor, insert: text },
      selection: { anchor: anchor + text.length },
    })
    this.view.focus()
  }

  getToolbarCommands(): ToolbarCommand[] {
    return this.pluginAPI.toolbar.getAll()
  }

  runToolbarCommand(id: string): void {
    const cmd = this.pluginAPI.toolbar.getAll().find(c => c.id === id)
    const ctx: EditorCommandContext = {}
    cmd?.run(ctx)
  }

  getActivePlugins(): import('./types').ActivePluginInfo[] {
    return [...this.activationMap.values()]
  }

  // see ADR-005
  private syncRemoteCursorsToView(): void {
    const positions: number[] = []
    for (const [clientId, state] of this.awareness.getStates()) {
      if (clientId === this.ydoc.clientID) continue
      const cursor = (state as { cursor?: { anchor: unknown; head: unknown } }).cursor
      if (!cursor) continue
      const anchorAbs = Y.createAbsolutePositionFromRelativePosition(
        cursor.anchor as Y.RelativePosition, this.ydoc,
      )
      const headAbs = Y.createAbsolutePositionFromRelativePosition(
        cursor.head as Y.RelativePosition, this.ydoc,
      )
      if (anchorAbs !== null) positions.push(anchorAbs.index)
      if (headAbs !== null) positions.push(headAbs.index)
    }
    this.view.dispatch({ effects: setRemoteCursorPositions.of(positions) })
  }

  destroy(): void {
    this.destroyed = true
    if (this.connectTimer !== null) clearTimeout(this.connectTimer)
    if (this.scopeDebounceTimer !== null) clearTimeout(this.scopeDebounceTimer)
    if (this.stabilizeDebounceTimer !== null) clearTimeout(this.stabilizeDebounceTimer)
    // Remove our cursor from awareness before disconnecting
    removeAwarenessStates(this.awareness, [this.ydoc.clientID], 'local')
    if (this.connection && this.connection.state !== HubConnectionState.Disconnected) {
      void this.connection.stop()
    }
    this.view.destroy()
    this.ydoc.destroy()
    this.events.destroy()
  }
}

