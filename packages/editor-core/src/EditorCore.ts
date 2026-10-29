// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { EditorView, keymap } from '@codemirror/view'
import { EditorState, Prec } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, moveLineUp, moveLineDown, copyLineDown, deleteLine, selectLine, undo, redo } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'

import type { EditorController, EditorCoreOptions, EditorEvent, MarkdownFormat, SelectionCoords, TriggerActivation, ToolbarCommand } from './types'
import type { EditorCommandContext, EditorPositionAPI, NoteScope, NotePluginScope, IEditorHostAPI, IPluginLoader, Hotkey, PluginCommand, PluginCommandContext } from '@savoire/plugin-api'
import { resolveActivePlugins } from './PluginActivationResolver'
import type { ActivationEntry } from './PluginActivationResolver'
import { toggleMarkdownFormat, toggleHighlight, setLineColor, toggleChecklistStatus, clearInlineFormatting, wrapSelection, insertCallout } from './FormattingService'
import { PLUME_COLORS } from './PlumeMarkdown'
import { EventBus } from './EventBus'
import { CommandRegistry, type CommandContext } from './CommandRegistry'
import { DocumentPipeline } from './DocumentPipeline'
import { createLivePreviewExtension, pluginsLoadedEffect } from './LivePreview'
import { imageInsertExtension, insertImageFiles } from './ImageInsert'
import { addProperty, propertiesPanelExtension, propertiesRefresh, toggleYamlSource } from './PropertiesPanel'
import type { PropertiesHost } from './PropertiesPanel'

// Detects a list item line: optional leading whitespace + bullet or ordered marker
const LIST_LINE_RE = /^(\s*)([-*+]|\d+\.) /

const LONE_SYMBOL_RE = /^(#{1,6}|[-*+]|>)\s*$/

const mod = (key: string, ...more: Hotkey['modifiers']): Hotkey[] => [{ modifiers: ['Mod', ...more], key }]

/** Vue d'un contexte de commande ou de bouton, quand l'appelant la donne. */
function viewOf(ctx: unknown): EditorView | undefined {
  const c = ctx as { view?: unknown; editorView?: unknown } | null | undefined
  const v = c?.view ?? c?.editorView
  return v instanceof EditorView ? v : undefined
}

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


/**
 * Commandes d'edition, declenchables au clavier (moteur de raccourcis).
 * Elles agissent sur l'editeur qui a le focus, jamais sur une instance
 * figee : le registre est partage par tous les editeurs. Seuls les
 * raccourcis courants ont une touche par defaut ; les autres commandes
 * existent pour qu'on puisse leur en donner une.
 */
export function plumeCommands(): PluginCommand[] {
  const on = (act: (view: EditorView) => void) => (ctx: PluginCommandContext) => {
    const view = viewOf(ctx)
    if (view) act(view)
  }
  const fmt = (f: import('./types').MarkdownFormat) => on(v => toggleMarkdownFormat(v, f))
  const commands: PluginCommand[] = [
    { id: 'editor:toggle-bold',           label: 'Gras',                  hotkeys: mod('b'),           run: fmt('bold') },
    { id: 'editor:toggle-italics',        label: 'Italique',              hotkeys: mod('i'),           run: fmt('italic') },
    { id: 'editor:toggle-strikethrough',  label: 'Barré',                 hotkeys: mod('x', 'Shift'),  run: fmt('strike') },
    { id: 'editor:toggle-code',           label: 'Code inline',           hotkeys: mod('e'),           run: fmt('code') },
    { id: 'editor:toggle-highlight',      label: 'Surligner',             hotkeys: mod('h', 'Shift'),  run: fmt('highlight') },
    { id: 'editor:insert-link',           label: 'Insérer un lien',       hotkeys: mod('k'),           run: fmt('link') },
    { id: 'editor:toggle-numbered-list',  label: 'Liste numérotée',       hotkeys: mod('7', 'Shift'),  run: fmt('ol') },
    { id: 'editor:toggle-bullet-list',    label: 'Liste à puces',         hotkeys: mod('8', 'Shift'),  run: fmt('ul') },
    { id: 'editor:toggle-checklist',      label: 'Liste de tâches',       hotkeys: mod('9', 'Shift'),  run: fmt('tasklist') },
    { id: 'editor:toggle-blockquote',     label: 'Citation',                                           run: fmt('blockquote') },
    { id: 'editor:set-paragraph',         label: 'Texte normal',                                       run: fmt('paragraph') },
    ...([1, 2, 3, 4, 5, 6] as const).map(n => ({
      id: `editor:set-heading-${n}`, label: `Titre ${n}`, run: fmt(`h${n}`),
    })),
    { id: 'editor:insert-codeblock',      label: 'Bloc de code',                                       run: fmt('codeblock') },
    { id: 'editor:insert-table',          label: 'Tableau',                                            run: fmt('table') },
    { id: 'editor:insert-image',          label: 'Image',                                              run: fmt('image') },
    { id: 'editor:insert-horizontal-rule', label: 'Séparateur',                                        run: fmt('hr') },
    ...PLUME_COLORS.map(c => ({
      id: `editor:highlight-${c.color}`, label: `Surligner en ${c.label.toLowerCase()}`,
      run: on(v => toggleHighlight(v, c.color)),
    })),
    ...PLUME_COLORS.map(c => ({
      id: `editor:text-color-${c.color}`, label: `Texte ${c.label.toLowerCase()}`,
      run: on(v => setLineColor(v, c.color)),
    })),
    { id: 'editor:text-color-none',       label: 'Couleur du texte par défaut',                        run: on(v => setLineColor(v, null)) },

    // Autres actions. Celles qui ont une touche reprennent celle de
    // CodeMirror : la liste des raccourcis dit ainsi ce qui marche vraiment.
    { id: 'editor:toggle-checklist-status', label: 'Cocher / décocher la case', hotkeys: mod('Enter'), run: on(toggleChecklistStatus) },
    { id: 'editor:clear-formatting',      label: 'Effacer la mise en forme',                           run: on(clearInlineFormatting) },
    { id: 'editor:indent-list',           label: 'Indenter l\'élément de liste',                       run: on(v => { indentListLine(v) }) },
    { id: 'editor:unindent-list',         label: 'Désindenter l\'élément de liste',                    run: on(v => { dedentListLine(v) }) },
    { id: 'editor:swap-line-up',          label: 'Monter la ligne',          hotkeys: [{ modifiers: ['Alt'], key: 'ArrowUp' }], run: on(v => { moveLineUp(v) }) },
    { id: 'editor:swap-line-down',        label: 'Descendre la ligne',       hotkeys: [{ modifiers: ['Alt'], key: 'ArrowDown' }], run: on(v => { moveLineDown(v) }) },
    { id: 'editor:duplicate-line',        label: 'Dupliquer la ligne',       hotkeys: [{ modifiers: ['Alt', 'Shift'], key: 'ArrowDown' }], run: on(v => { copyLineDown(v) }) },
    { id: 'editor:delete-line',           label: 'Supprimer la ligne',       hotkeys: mod('k', 'Shift'), run: on(v => { deleteLine(v) }) },
    { id: 'editor:select-line',           label: 'Sélectionner la ligne',    hotkeys: [{ modifiers: ['Alt'], key: 'l' }], run: on(v => { selectLine(v) }) },
    { id: 'editor:undo',                  label: 'Annuler',                  hotkeys: mod('z'), run: on(v => { undo(v) }) },
    { id: 'editor:redo',                  label: 'Rétablir',                 hotkeys: [...mod('y'), ...mod('z', 'Shift')], run: on(v => { redo(v) }) },
    { id: 'editor:insert-wikilink',       label: 'Insérer un lien vers une note',                      run: on(v => wrapSelection(v, '[[', ']]')) },
    { id: 'editor:insert-embed',          label: 'Intégrer une note',                                  run: on(v => wrapSelection(v, '![[', ']]')) },
    { id: 'editor:insert-callout',        label: 'Insérer un callout',                                 run: on(v => insertCallout(v)) },
    { id: 'editor:insert-tag',            label: 'Insérer un tag',                                     run: on(v => wrapSelection(v, '#', '')) },
    // Panneau des proprietes (frontmatter).
    { id: 'editor:add-property',          label: 'Ajouter une propriété',    hotkeys: mod(';'), run: on(addProperty) },
    { id: 'editor:toggle-properties-source', label: 'Propriétés : basculer panneau / YAML source', run: on(toggleYamlSource) },
  ]
  return commands.map(cmd => ({ ...cmd, editor: true }))
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
    views: { ...emptyReg, registerGroup: noop, unregisterGroup: noop, getGroups: () => [] },
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

// ── Liens des proprietes ──────────────────────────────────────────────────

/**
 * Chemin de la note visee par `[[cible]]`, comme Obsidian : chemin exact
 * (extension .md facultative), sinon la note qui porte ce nom (la plus
 * proche de la racine).
 */
function resolveNotePath(target: string, paths: readonly string[]): string | undefined {
  const t = target.trim().replace(/^\/+/, '')
  if (!t) return undefined
  if (paths.includes(t)) return t
  if (paths.includes(`${t}.md`)) return `${t}.md`
  const stem = (p: string) => p.slice(p.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '')
  const same = paths.filter(p => stem(p) === t || p.endsWith(`/${t}`) || p.endsWith(`/${t}.md`))
  return same.sort((a, b) => a.length - b.length || a.localeCompare(b))[0]
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
  private unsubPropertyTypes: (() => void) | null = null

  readonly commands = new CommandRegistry()
  readonly pipeline = new DocumentPipeline()
  readonly pluginAPI: IEditorHostAPI

  constructor(private options: EditorCoreOptions) {
    this.activeFile = options.filePath ?? null
    // see ADR-008
    this.pluginAPI = options.pluginAPI ?? createNoopHostAPI()
    if (options.crdt && options.userId) {
      options.crdt.setLocalUser(options.userId)
    }
    const ctx = {
      editorView: null as unknown,
      edit: (from: number, to: number, insert: string) => {
        if (options.readOnly) return
        this.view.dispatch({ changes: { from, to, insert } })
      },
      // Ligne qui porte un rendu de bloc : pour qu'un plugin y ecrive (taille d'une image).
      locate: (el: HTMLElement) => {
        if (options.readOnly) return null
        try {
          const line = this.view.state.doc.lineAt(this.view.posAtDOM(el))
          return { from: line.from, to: line.to, text: line.text }
        } catch {
          return null
        }
      },
    }
    // Images : coller, deposer, bouton Image. Le vault range le fichier,
    // quel que soit le profil de synchro (dans le dossier de cette note) ;
    // l'editeur n'insere que le lien.
    const vault = options.vault
    const uploadImage = vault?.uploadAttachment
      ? async (file: File) => {
          const notePath = this.activeFile ?? undefined
          const path = await vault.uploadAttachment!(file, notePath ? { notePath } : undefined)
          return vault.linkTarget?.(path) ?? path
        }
      : null

    let lastCursorLine = -1

    // Panneau des proprietes : types et valeurs du vault par l'API des
    // plugins (api.properties, api.query), liens ouverts par le workspace.
    const api = () => this.pluginAPI
    const propertiesHost: PropertiesHost = {
      readOnly: !!options.readOnly,
      types: () => api().properties,
      knownValues: async (key: string) => {
        const r = await api().query?.query({ from: { notes: true }, groupBy: { prop: key }, limit: 1 })
        return (r?.groups ?? []).map(g => g.key).filter((k): k is string => typeof k === 'string')
      },
      members: async () => (await api().properties?.members?.()) ?? [],
      openLink: (target: string) => {
        // Les notes du vault qui portent ce nom (moteur de requetes), sinon l'index connu.
        const name = target.slice(target.lastIndexOf('/') + 1)
        void (api().query?.query({
          from: { notes: true },
          where: { or: [{ field: { doc: 'title' }, op: 'eq', value: name }, { field: { doc: 'path' }, op: 'eq', value: target }] },
          limit: 50,
        }).then(r => r.rows.map(row => row.path), () => [] as string[]) ?? Promise.resolve([] as string[])).then(found => {
          const paths = [...found, ...(api().vault.getFileTree?.() ?? []).map(e => e.path)]
          void api().workspace.openFile(resolveNotePath(target, paths) ?? target)
        })
      },
    }

    const crdtMode = options.crdt !== undefined
    const offlineDoc = crdtMode ? '' : (options.initialContent ?? '')
    const startState = EditorState.create({
      doc: offlineDoc,
      selection: crdtMode ? undefined : { anchor: offlineDoc.length },
      extensions: [
        ...(options.readOnly
          ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
          : [
              history(),
              // Moteur de raccourcis (commandes de l'application et des
              // plugins) : passe avant les touches de CodeMirror.
              Prec.highest(EditorView.domEventHandlers({
                keydown: (event, view) => this.pluginAPI.hotkeys?.handleKeyEvent(event, { editorView: view }) ?? false,
              })),
              keymap.of([
                { key: 'Tab', run: indentListLine },
                { key: 'Shift-Tab', run: dedentListLine, preventDefault: true },
                ...defaultKeymap,
                ...historyKeymap,
              ]),
            ]
        ),
        ...(uploadImage ? [imageInsertExtension(uploadImage)] : []),
        // Une longue ligne passe a la ligne, en edition comme une fois rendue.
        EditorView.lineWrapping,
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(defaultHighlightStyle),
        ...(options.crdt?.getExtensions() ?? []),
        // Mode « source » : Markdown brut, aucune decoration. Meme document,
        // meme CRDT — seul le rendu change.
        ...(options.editorMode === 'source'
          ? []
          : [
              ...propertiesPanelExtension(propertiesHost),
              ...createLivePreviewExtension(this.pluginAPI.blocks, this.pluginAPI.hooks, ctx, options.showLineNumbers ?? true, () => new Set(this.activationMap.keys())),
            ]),
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
              const clock = this.options.crdt?.getVersion().clock ?? 0
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

    // Un membre change le type d'une propriete : le panneau se redessine.
    this.unsubPropertyTypes = this.pluginAPI.properties?.onChange(() => {
      this.view.dispatch({ effects: propertiesRefresh.of(null) })
    }) ?? null

    this.loadPlugins()

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
    // Jeu complet de commandes de mise en forme. Elles vivent dans le REGISTRE,
    // pas en dur dans le composant : c'est ce qui permet a un plugin d'en
    // ajouter les siennes (toolbar.register) et a l'hote de les reordonner.
    // Les groupes sont rendus separes par une barre verticale, dans cet ordre.
    // Le bouton agit sur l'editeur d'ou vient le clic : la barre est
    // partagee par tous les editeurs ouverts.
    const F = (f: import('./types').MarkdownFormat) => (ctx: EditorCommandContext) =>
      toggleMarkdownFormat(viewOf(ctx) ?? this.view, f)
    const highlightIn = (color?: (typeof PLUME_COLORS)[number]['color']) => (ctx: EditorCommandContext) =>
      toggleHighlight(viewOf(ctx) ?? this.view, color)
    const colorIn = (color: (typeof PLUME_COLORS)[number]['color'] | null) => (ctx: EditorCommandContext) =>
      setLineColor(viewOf(ctx) ?? this.view, color)
    const toolbarCmds: ToolbarCommand[] = [
      // Menu deroulant : les six niveaux de titre existent dans
      // FormattingService, les etaler en boutons rendait la barre illisible.
      {
        id: 'tb-heading', label: 'Style de bloc', icon: 'H▾', group: 'bloc',
        run: F('paragraph'),
        items: [
          { id: 'tb-paragraph', label: 'Texte normal', icon: '¶',  run: F('paragraph') },
          { id: 'tb-h1', label: 'Titre 1', icon: 'H1', run: F('h1') },
          { id: 'tb-h2', label: 'Titre 2', icon: 'H2', run: F('h2') },
          { id: 'tb-h3', label: 'Titre 3', icon: 'H3', run: F('h3') },
          { id: 'tb-h4', label: 'Titre 4', icon: 'H4', run: F('h4') },
          { id: 'tb-h5', label: 'Titre 5', icon: 'H5', run: F('h5') },
          { id: 'tb-h6', label: 'Titre 6', icon: 'H6', run: F('h6') },
        ],
      },

      { id: 'tb-bold',      label: 'Gras',           icon: 'B',   group: 'format', requiresSelection: false, commandId: 'editor:toggle-bold', run: F('bold') },
      { id: 'tb-italic',    label: 'Italique',       icon: 'I',   group: 'format', requiresSelection: false, commandId: 'editor:toggle-italics', run: F('italic') },
      { id: 'tb-strike',    label: 'Barré',          icon: 'S',   group: 'format', requiresSelection: false, commandId: 'editor:toggle-strikethrough', run: F('strike') },
      { id: 'tb-code',      label: 'Code inline',    icon: '`c`', group: 'format', requiresSelection: false, commandId: 'editor:toggle-code', run: F('code') },
      // Surlignage : couleur du theme, ou l'une des six couleurs d'Obsidian.
      {
        id: 'tb-highlight', label: 'Surligner', icon: '🖍', group: 'format', requiresSelection: false,
        commandId: 'editor:toggle-highlight', run: highlightIn(),
        items: [
          { id: 'tb-hl-default', label: 'Surligner', icon: '🖍', commandId: 'editor:toggle-highlight', run: highlightIn() },
          ...PLUME_COLORS.map(c => ({
            id: `tb-hl-${c.color}`, label: `Surligner en ${c.label.toLowerCase()}`, icon: c.emoji,
            commandId: `editor:highlight-${c.color}`, run: highlightIn(c.color),
          })),
        ],
      },
      // Couleur du texte : toute la ligne, marquee par `🔴` en debut de ligne.
      {
        id: 'tb-text-color', label: 'Couleur du texte', icon: '🎨', group: 'format', requiresSelection: false,
        run: colorIn(null),
        items: [
          ...PLUME_COLORS.map(c => ({
            id: `tb-color-${c.color}`, label: `Texte ${c.label.toLowerCase()}`, icon: c.emoji,
            commandId: `editor:text-color-${c.color}`, run: colorIn(c.color),
          })),
          { id: 'tb-color-none', label: 'Couleur par défaut', icon: '⊘', commandId: 'editor:text-color-none', run: colorIn(null) },
        ],
      },

      { id: 'tb-ul',        label: 'Liste à puces',  icon: '•',   group: 'liste',  commandId: 'editor:toggle-bullet-list', run: F('ul') },
      { id: 'tb-ol',        label: 'Liste numérotée', icon: '1.', group: 'liste',  commandId: 'editor:toggle-numbered-list', run: F('ol') },
      { id: 'tb-task',      label: 'Liste de tâches', icon: '☑',  group: 'liste',  commandId: 'editor:toggle-checklist', run: F('tasklist') },

      { id: 'tb-quote',     label: 'Citation',       icon: '❝',   group: 'insert', commandId: 'editor:toggle-blockquote', run: F('blockquote') },
      { id: 'tb-codeblock', label: 'Bloc de code',   icon: '</>', group: 'insert', commandId: 'editor:insert-codeblock', run: F('codeblock') },
      { id: 'tb-table',     label: 'Tableau',        icon: '⊞',   group: 'insert', commandId: 'editor:insert-table', run: F('table') },
      { id: 'tb-link',      label: 'Lien',           icon: '🔗',  group: 'insert', commandId: 'editor:insert-link', run: F('link') },
      { id: 'tb-image',     label: 'Image',          icon: '🖼',  group: 'insert', run: F('image') },
      { id: 'tb-hr',        label: 'Séparateur',     icon: '—',   group: 'insert', run: F('hr') },
    ]
    for (const cmd of toolbarCmds) toolbar.register(cmd)

    for (const cmd of plumeCommands()) this.pluginAPI.commands.register(cmd)
  }


  describeHotkey(commandId: string): string | null {
    const hotkeys = this.pluginAPI.hotkeys
    const first = hotkeys?.get(commandId)[0]
    return first && hotkeys ? hotkeys.format(first) : null
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
    return this.options.getTransportState?.() ?? 'disconnected'
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

  /** Envoie des images et insere leurs liens au curseur (meme chemin que coller/deposer). */
  async insertImageFiles(files: File[]): Promise<void> {
    await insertImageFiles(this.view, files, this.view.state.selection.main.head)
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
    const all = this.pluginAPI.toolbar.getAll()
    const cmd = all.find(c => c.id === id) ?? all.flatMap(c => c.items ?? []).find(c => c.id === id)
    const ctx: EditorCommandContext = { view: this.view }
    cmd?.run(ctx)
  }

  getActivePlugins(): import('./types').ActivePluginInfo[] {
    return [...this.activationMap.values()]
  }

  destroy(): void {
    if (this.scopeDebounceTimer !== null) clearTimeout(this.scopeDebounceTimer)
    if (this.stabilizeDebounceTimer !== null) clearTimeout(this.stabilizeDebounceTimer)
    this.unsubPropertyTypes?.()
    this.options.crdt?.dispose()
    this.view.destroy()
    this.events.destroy()
  }
}

