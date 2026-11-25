// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { applyHighlights, highlightsExtension, type EditorHighlight } from './Highlights'
import { applyBlockMarks, blockMarksExtension, type BlockMark } from './BlockMarks'
import { agentPresenceExtension, applyAgentPresence, type AgentPresence } from './AgentPresence'
import { agentCursorsExtension } from './AgentCursors'
import { aiChangeFlashFor, setAiChangeHost, type AiChangeHost } from './AiChangeFlash'
import { aiMarksExtension, applyAiMarks, type AiMarkRange } from './AiMarks'
import { setSuggestionSink, suggestionModeExtension, type SuggestionSink } from './SuggestionMode'
import { annotationsExtension, closeAnnotations, openAnnotationDraft, setAnnotationHost, type AnnotationDraft, type AnnotationHost } from './Annotations'
import { EditorView, keymap } from '@codemirror/view'
import { EditorState, Facet, Prec, Transaction } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, moveLineUp, moveLineDown, copyLineDown, deleteLine, selectLine, undo, redo } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { printNote } from './PdfExport'
import { startSlideShow, type SlideShowHandle } from './SlideShow'
import { downloadSlidesPptx, printSlides } from './SlidesExport'
import { slideMarksExtension } from './SlideMarks'
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'

import { isSlidesNote, minimalTextChange, resolveLinkPath, setFrontmatterValue, slideDeck, slideIndexAt } from '@savoire/plugin-api'
import type { EditorController, EditorCoreOptions, EditorEvent, MarkdownFormat, SelectionCoords, TriggerActivation, ToolbarCommand } from './types'
import type { VaultAPI } from '@savoire/plugin-api'
import type { EditorCommandContext, EditorPositionAPI, NoteScope, NotePluginScope, IEditorHostAPI, IPluginLoader, Hotkey, PluginCommand, PluginCommandContext } from '@savoire/plugin-api'
import { resolveActivePlugins } from './PluginActivationResolver'
import type { ActivationEntry } from './PluginActivationResolver'
import { toggleMarkdownFormat, toggleHighlight, setLineColor, toggleChecklistStatus, clearInlineFormatting, wrapSelection, insertCallout } from './FormattingService'
import { PLUME_COLORS, PLUME_COLOR_VALUES } from './PlumeMarkdown'
import { BLOCK_LABELS, formatStateAt, type BlockStyle, type InlineStyle, type ListStyle } from './FormatState'
import { EventBus } from './EventBus'
import { CommandRegistry, type CommandContext } from './CommandRegistry'
import { DocumentPipeline } from './DocumentPipeline'
import { createLivePreviewExtension, pluginsLoadedEffect } from './LivePreview'
import { foldAllHeadings, foldStorage, toggleFoldAtCursor, unfoldAll } from './Folding'
import { imageInsertExtension, insertImageFiles } from './ImageInsert'
import { addProperty, propertiesPanelExtension, propertiesRefresh, toggleYamlSource } from './PropertiesPanel'
import type { PropertiesHost } from './PropertiesPanel'
import { brackets, dedentListItem, enterBeforeHeading, highlightSelectionMatches, indentListItem, listHome, tripleClickLine, multipleCursors, multipleCursorsEnabled, renumberOrderedLists, selectAllOccurrences, selectNextOccurrence, spellcheck } from './EditingAids'
import { findReplace, openFind } from './FindReplace'
import { noteTitleExtension, notePathChanged, renameNoteForTitle } from './NoteTitle'
import { smartPaste } from './SmartPaste'
import { notePosition } from './NotePosition'
import { focusedSubEditor, hostOf, subEditorExtensions } from './SubEditor'

/**
 * Insere une nouvelle diapositive apres celle du curseur (`---` entre deux
 * lignes vides). Une note qui n'est pas encore une presentation le devient
 * (`type: slides`).
 */
function insertSlide(view: EditorView): void {
  if (!isSlidesNote(view.state.doc.toString())) {
    const text = view.state.doc.toString()
    const change = minimalTextChange(text, setFrontmatterValue(text, 'type', 'slides'))
    if (change) view.dispatch({ changes: change, userEvent: 'input' })
  }
  const doc = view.state.doc.toString()
  const deck = slideDeck(doc)
  const slide = deck.slides[slideIndexAt(deck, view.state.selection.main.head)]
  // Fin de la diapositive (notes comprises) : le separateur de la suivante, ou la fin.
  const end = slide ? slide.to : doc.length
  const from = doc.slice(0, end).replace(/\s+$/, '').length
  const head = '\n\n---\n\n## '
  view.dispatch({
    changes: { from, to: end, insert: end < doc.length ? `${head}\n\n` : head },
    selection: { anchor: from + head.length },
    userEvent: 'input',
    scrollIntoView: true,
  })
  view.focus()
}

const LONE_SYMBOL_RE = /^(#{1,6}|[-*+]|>)\s*$/

const mod = (key: string, ...more: Hotkey['modifiers']): Hotkey[] => [{ modifiers: ['Mod', ...more], key }]

/** Vue d'un contexte de commande ou de bouton, quand l'appelant la donne. */
function viewOf(ctx: unknown): EditorView | undefined {
  const c = ctx as { view?: unknown; editorView?: unknown } | null | undefined
  const v = c?.view ?? c?.editorView
  // Une case de tableau ouverte : c'est elle qu'on met en forme.
  return v instanceof EditorView ? (focusedSubEditor(v) ?? v) : undefined
}


/**
 * Commandes d'edition, declenchables au clavier (moteur de raccourcis).
 * Elles agissent sur l'editeur qui a le focus, jamais sur une instance
 * figee : le registre est partage par tous les editeurs. Seuls les
 * raccourcis courants ont une touche par defaut ; les autres commandes
 * existent pour qu'on puisse leur en donner une.
 */
/** Marques de debut de ligne qu'insere le menu « / ». */
const LINE_PREFIX_RE = /^(#{1,6} |[-*+] \[[ xX]\] |[-*+] |\d+[.)] |> )$/
/** Retrait et marque deja presents en tete d'une ligne. */
const EXISTING_PREFIX_RE = /^(\s*)(#{1,6}[ \t]+|[-*+] \[[ xX]\] |[-*+] |\d+[.)] |> )?/

/** Annuler / retablir du CRDT de l'editeur (sinon, l'historique de CodeMirror). */
interface UndoCommands { undo(view: EditorView): boolean; redo(view: EditorView): boolean }
const crdtHistory = Facet.define<UndoCommands, UndoCommands | null>({ combine: v => v[0] ?? null })

function undoIn(view: EditorView): void {
  const h = view.state.facet(crdtHistory)
  if (h) h.undo(view)
  else undo(view)
}

function redoIn(view: EditorView): void {
  const h = view.state.facet(crdtHistory)
  if (h) h.redo(view)
  else redo(view)
}

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
    { id: 'editor:indent-list',           label: 'Indenter l\'élément de liste',                       run: on(v => { indentListItem(v) }) },
    { id: 'editor:unindent-list',         label: 'Désindenter l\'élément de liste',                    run: on(v => { dedentListItem(v) }) },
    { id: 'editor:swap-line-up',          label: 'Monter la ligne',          hotkeys: [{ modifiers: ['Alt'], key: 'ArrowUp' }], run: on(v => { moveLineUp(v) }) },
    { id: 'editor:swap-line-down',        label: 'Descendre la ligne',       hotkeys: [{ modifiers: ['Alt'], key: 'ArrowDown' }], run: on(v => { moveLineDown(v) }) },
    { id: 'editor:duplicate-line',        label: 'Dupliquer la ligne',       hotkeys: [{ modifiers: ['Alt', 'Shift'], key: 'ArrowDown' }], run: on(v => { copyLineDown(v) }) },
    { id: 'editor:delete-line',           label: 'Supprimer la ligne',       hotkeys: mod('k', 'Shift'), run: on(v => { deleteLine(v) }) },
    { id: 'editor:select-line',           label: 'Sélectionner la ligne',    hotkeys: [{ modifiers: ['Alt'], key: 'l' }], run: on(v => { selectLine(v) }) },
    { id: 'editor:undo',                  label: 'Annuler',                  hotkeys: mod('z'), run: on(undoIn) },
    { id: 'editor:redo',                  label: 'Rétablir',                 hotkeys: [...mod('y'), ...mod('z', 'Shift')], run: on(redoIn) },
    { id: 'editor:insert-wikilink',       label: 'Insérer un lien vers une note',                      run: on(v => wrapSelection(v, '[[', ']]')) },
    { id: 'editor:insert-embed',          label: 'Intégrer une note',                                  run: on(v => wrapSelection(v, '![[', ']]')) },
    { id: 'editor:insert-callout',        label: 'Insérer un callout',                                 run: on(v => insertCallout(v)) },
    { id: 'editor:insert-tag',            label: 'Insérer un tag',                                     run: on(v => wrapSelection(v, '#', '')) },
    // Panneau des proprietes (frontmatter).
    { id: 'editor:add-property',          label: 'Ajouter une propriété',    hotkeys: mod(';'), run: on(v => addProperty(hostOf(v))) },
    { id: 'editor:toggle-properties-source', label: 'Propriétés : basculer panneau / YAML source', run: on(toggleYamlSource) },
    // Rechercher et remplacer dans la note (FindReplace.ts).
    { id: 'editor:find',                  label: 'Rechercher dans la note',  hotkeys: mod('f'), run: on(v => { openFind(hostOf(v)) }) },
    { id: 'editor:replace',               label: 'Remplacer dans la note',   hotkeys: mod('h'), run: on(v => { openFind(hostOf(v), true) }) },
    // Plusieurs curseurs, si l'option est cochee (EditingAids.ts).
    { id: 'editor:select-next-occurrence', label: 'Ajouter l\'occurrence suivante à la sélection', hotkeys: mod('d'), isAvailable: () => multipleCursorsEnabled(), run: on(v => { selectNextOccurrence(v) }) },
    { id: 'editor:select-all-occurrences', label: 'Sélectionner toutes les occurrences', hotkeys: mod('l', 'Shift'), isAvailable: () => multipleCursorsEnabled(), run: on(v => { selectAllOccurrences(v) }) },
    // Repli des titres et des listes (Folding.ts).
    { id: 'editor:toggle-fold',           label: 'Replier / déplier le bloc',                          run: on(v => { toggleFoldAtCursor(v) }) },
    { id: 'editor:fold-all',              label: 'Replier tous les titres',                            run: on(v => { foldAllHeadings(v) }) },
    { id: 'editor:unfold-all',            label: 'Tout déplier',                                       run: on(v => { unfoldAll(v) }) },
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

/** Chemin de la note visee par `[[cible]]`, comme Obsidian (voir plugin-api, links.ts). */
const resolveNotePath = resolveLinkPath

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
  /** Editeurs ouverts : prevenus quand un plugin d'edition arrive apres eux. */
  private static readonly live = new Set<EditorCore>()

  /**
   * Un plugin d'edition actif partout (defaultActive) vient d'etre charge :
   * les editeurs deja ouverts le prennent en compte (ses blocs s'affichent
   * sans rouvrir la note).
   */
  static refreshAll(): void {
    for (const e of EditorCore.live) e.refreshPlugins()
  }

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
  /** Une frappe locale attend la prochaine stabilisation. */
  private localEditPending = false
  private unsubPropertyTypes: (() => void) | null = null

  readonly commands = new CommandRegistry()
  readonly pipeline = new DocumentPipeline()
  readonly pluginAPI: IEditorHostAPI

  constructor(private options: EditorCoreOptions) {
    EditorCore.live.add(this)
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
      icons: () => api().icons,
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
    const crdtUndo: UndoCommands | null = options.crdt?.undo && options.crdt.redo
      ? { undo: v => options.crdt!.undo!(v), redo: v => options.crdt!.redo!(v) }
      : null
    const hotkeyEngine = Prec.highest(EditorView.domEventHandlers({
      keydown: (event, view) => this.pluginAPI.hotkeys?.handleKeyEvent(event, { editorView: view }) ?? false,
    }))
    const offlineDoc = crdtMode ? '' : (options.initialContent ?? '')
    const startState = EditorState.create({
      doc: offlineDoc,
      selection: crdtMode ? undefined : { anchor: offlineDoc.length },
      extensions: [
        ...(options.readOnly
          ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
          : [
              // Note partagee : l'annulation du CRDT, qui ne touche qu'aux
              // modifications faites ici (pas au texte recu).
              ...(crdtUndo ? [crdtHistory.of(crdtUndo)] : [history()]),
              // Moteur de raccourcis (commandes de l'application et des
              // plugins) : passe avant les touches de CodeMirror.
              hotkeyEngine,
              // Les sous-editeurs (case d'un tableau) : le meme moteur, les memes aides.
              subEditorExtensions.of([
                history(),
                hotkeyEngine,
                keymap.of([...defaultKeymap, ...historyKeymap]),
                spellcheck,
                highlightSelectionMatches,
                brackets,
                smartPaste,
                EditorView.lineWrapping,
              ]),
              keymap.of([
                { key: 'Tab', run: indentListItem },
                { key: 'Shift-Tab', run: dedentListItem, preventDefault: true },
                ...defaultKeymap,
                ...(crdtUndo
                  ? [
                      { key: 'Mod-z', run: crdtUndo.undo, preventDefault: true },
                      { key: 'Mod-y', mac: 'Mod-Shift-z', run: crdtUndo.redo, preventDefault: true },
                      { key: 'Mod-Shift-z', run: crdtUndo.redo, preventDefault: true },
                    ]
                  : historyKeymap),
              ]),
            ]
        ),
        ...(uploadImage ? [imageInsertExtension(uploadImage)] : []),
        // Aides d'ecriture (EditingAids.ts), rechercher (FindReplace.ts),
        // coller (SmartPaste.ts), position retenue (NotePosition.ts).
        spellcheck,
        listHome,
        tripleClickLine,
        enterBeforeHeading,
        highlightSelectionMatches,
        multipleCursors,
        findReplace,
        ...(options.readOnly ? [] : [brackets, smartPaste, renumberOrderedLists]),
        ...(options.docId ? [notePosition(options.docId)] : []),
        // Le titre (H1) en haut de la note ; le fichier le suit (NoteTitle.ts).
        ...(/\.md$/i.test(options.filePath ?? '') ? [noteTitleExtension({
          path: () => this.activeFile,
          placeholder: options.editorMode !== 'source',
          rename: title => this.renameForTitle(title),
        })] : []),
        // Une longue ligne passe a la ligne, en edition comme une fois rendue.
        EditorView.lineWrapping,
        // Passages surlignes par l'application (revision).
        highlightsExtension(),
        // Agent en veille sur la note : un robot en bas a droite.
        agentPresenceExtension(),
        // Passages surlignes et epingles pour l'IA (personnels, hors du texte).
        aiMarksExtension(),
        // Cartes de revision par-dessus la note (clic sur un passage surligne).
        annotationsExtension(),
        suggestionModeExtension(),
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(defaultHighlightStyle),
        ...(options.crdt?.getExtensions() ?? []),
        // Un agent IA qui lit ou ecrit dans la note, en direct (AgentCursors.ts).
        ...(options.crdt?.agentPeers && options.crdt.onAgentPeersChange
          ? [agentCursorsExtension({ list: () => options.crdt!.agentPeers!(), subscribe: cb => options.crdt!.onAgentPeersChange!(cb) })]
          : []),
        // Ce que l'IA vient de changer, surligne un instant (AiChangeFlash.ts).
        ...aiChangeFlashFor(options.crdt, { docId: options.docId }),
        // Mode « source » : Markdown brut, aucune decoration. Meme document,
        // meme CRDT — seul le rendu change.
        ...(options.editorMode === 'source'
          ? []
          : [
              ...propertiesPanelExtension(propertiesHost),
              // Les blocs replies d'une note, retenus sur l'appareil.
              foldStorage.of(options.docId ?? null),
              ...createLivePreviewExtension(
                this.pluginAPI.blocks, this.pluginAPI.hooks, ctx, options.showLineNumbers ?? true,
                () => { this.syncDefaults(); return new Set(this.activationMap.keys()) },
                options.editorMode === 'classic' ? 'classic' : 'power',
              ),
              // Note `type: slides` : debut de chaque diapositive, notes du presentateur.
              ...(/\.md$/i.test(options.filePath ?? '') ? [slideMarksExtension({ present: i => this.presentSlides(this.view, i) })] : []),
            ]),
        // Marques de blocs (modifie depuis la derniere visite, agent en veille) :
        // une gouttiere apres les numeros de ligne, contre le texte.
        blockMarksExtension(),
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

            // Frappe de la personne (pas un changement venu d'un pair) :
            // l'historique des versions l'attribue a son auteur.
            if (update.transactions.some(tr => tr.annotation(Transaction.userEvent) !== undefined)) {
              this.localEditPending = true
              // Pour l'IA : un agent n'ecrit pas dans le paragraphe ou l'on tape.
              this.events.emit('userTyped', update)
            }

            // see ADR-015
            if (this.stabilizeDebounceTimer !== null) clearTimeout(this.stabilizeDebounceTimer)
            this.stabilizeDebounceTimer = setTimeout(() => {
              this.stabilizeDebounceTimer = null
              const content = update.view.state.doc.toString()
              const docId = this.options.docId ?? ''
              const path  = this.activeFile ?? ''
              const clock = this.options.crdt?.getVersion().clock ?? 0
              const local = this.localEditPending
              this.localEditPending = false
              this.pluginAPI.hooks.runDocumentStabilized(docId, path, content, { clock }, { local })
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
          const all = slash.getAll().flatMap(item => {
            if (!item.expand) return [item]
            try { return item.expand() } catch { return [] }
          })
          // Sans accents ni casse : « /modele » trouve « Modèle ».
          const fold = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
          const q = fold(query)
          const filtered = !query ? all : all.filter(item =>
            fold(item.label).includes(q) || (item.description ? fold(item.description).includes(q) : false))
          // Adapt SlashCommandItem to TriggerItem (normalize insert signature)
          return filtered.map(item => ({
            id: item.id,
            label: item.label,
            icon: item.icon,
            category: item.category,
            description: item.description,
            cursor: item.cursor,
            keepOpen: item.keepOpen,
            insert: typeof item.insert === 'function'
              ? (q: string) => (item.insert as (ctx: { query: string }) => string)({ query: q })
              : item.insert,
          }))
        },
        // no onCommit — default commitTriggerInsert is used
      },
    })

    const builtins = [
      { id: 'builtin-h1',         label: 'Titre 1',         description: 'H1 · Grand titre (# )',         icon: 'heading-1', category: 'Titres',  insert: '# '   },
      { id: 'builtin-h2',         label: 'Titre 2',         description: 'H2 · Titre moyen (## )',         icon: 'heading-2', category: 'Titres',  insert: '## '  },
      { id: 'builtin-h3',         label: 'Titre 3',         description: 'H3 · Petit titre (### )',        icon: 'heading-3', category: 'Titres',  insert: '### ' },
      { id: 'builtin-h4',         label: 'Titre 4',         description: 'H4 · Sous-titre (#### )',        icon: 'heading-4', category: 'Titres',  insert: '#### ' },
      { id: 'builtin-ul',         label: 'Liste à puces',   description: 'Liste non ordonnée (- )',   icon: 'list',         category: 'Listes',  insert: '- '   },
      { id: 'builtin-ol',         label: 'Liste numérotée', description: 'Liste ordonnée (1. )',      icon: 'list-ordered', category: 'Listes',  insert: '1. '  },
      { id: 'builtin-todo',       label: 'Case à cocher',   description: 'Liste de tâches (- [ ] )', icon: 'list-checks',  category: 'Listes',  insert: '- [ ] ' },
      { id: 'builtin-blockquote', label: 'Citation',        description: 'Bloc de citation (> )',     icon: 'text-quote',  category: 'Blocs',   insert: '> '   },
      { id: 'builtin-code',       label: 'Bloc de code',    description: 'Bloc de code (```)',        icon: 'square-code', category: 'Blocs',  insert: '```\n\n```' },
      { id: 'builtin-table',      label: 'Tableau',         description: 'Tableau Markdown',          icon: 'table',       category: 'Blocs',   insert: '| Col 1 | Col 2 |\n| --- | --- |\n| | |' },
      { id: 'builtin-hr',         label: 'Séparateur',      description: 'Ligne horizontale (---)',   icon: 'minus',       category: 'Blocs',   insert: '---'  },
      // Colonnes (ADR-030) : le curseur dans la premiere colonne.
      { id: 'builtin-columns-2',  label: '2 colonnes',      description: 'Deux colonnes cote a cote (::: colonnes)', icon: 'columns-2', category: 'Mise en page', insert: '::: colonnes\n\n+++\n\n:::', cursor: 13 },
      { id: 'builtin-columns-3',  label: '3 colonnes',      description: 'Trois colonnes (::: colonnes)',            icon: 'columns-3', category: 'Mise en page', insert: '::: colonnes\n\n+++\n\n+++\n\n:::', cursor: 13 },
      { id: 'builtin-columns-img', label: 'Image et texte', description: 'Image a gauche, texte a droite (::: colonnes 1 2)', icon: 'panel-left', category: 'Mise en page', insert: '::: colonnes 1 2\n![[]]\n+++\n\n:::', cursor: 20 },
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
      toggleMarkdownFormat(viewOf(ctx) ?? this.targetView(), f)
    const highlightIn = (color?: (typeof PLUME_COLORS)[number]['color']) => (ctx: EditorCommandContext) =>
      toggleHighlight(viewOf(ctx) ?? this.targetView(), color)
    const colorIn = (color: (typeof PLUME_COLORS)[number]['color'] | null) => (ctx: EditorCommandContext) =>
      setLineColor(viewOf(ctx) ?? this.targetView(), color)
    // Etat sous le curseur : boutons allumes, style du paragraphe.
    const stateOf = (ctx: EditorCommandContext) => formatStateAt((viewOf(ctx) ?? this.targetView()).state)
    const isInline = (f: InlineStyle) => (ctx: EditorCommandContext) => stateOf(ctx).inline.has(f)
    const isBlock = (b: BlockStyle) => (ctx: EditorCommandContext) => stateOf(ctx).block === b
    const isList = (l: ListStyle) => (ctx: EditorCommandContext) => stateOf(ctx).list === l
    const heading = (level: 1 | 2 | 3 | 4 | 5 | 6): ToolbarCommand => ({
      id: `tb-h${level}`, label: `Titre ${level}`, icon: `heading-${level}`,
      commandId: `editor:set-heading-${level}`, run: F(`h${level}`), isActive: isBlock(`h${level}`),
    })
    const toolbarCmds: ToolbarCommand[] = [
      // Le style du paragraphe : le bouton montre celui du curseur.
      {
        id: 'tb-heading', label: 'Style du paragraphe', icon: 'heading', group: 'bloc', bubble: true,
        currentLabel: ctx => BLOCK_LABELS[stateOf(ctx).block],
        run: F('paragraph'),
        items: [
          { id: 'tb-paragraph', label: 'Texte', icon: 'pilcrow', run: F('paragraph'), isActive: isBlock('paragraph') },
          heading(1), heading(2), heading(3), heading(4), heading(5), heading(6),
          { id: 'tb-block-quote', label: 'Citation', icon: 'text-quote', commandId: 'editor:toggle-blockquote', run: F('blockquote'), isActive: isBlock('blockquote') },
          { id: 'tb-block-code', label: 'Bloc de code', icon: 'square-code', commandId: 'editor:insert-codeblock', run: F('codeblock'), isActive: isBlock('codeblock') },
        ],
      },

      { id: 'tb-bold',   label: 'Gras',     icon: 'bold',          group: 'format', bubble: true, commandId: 'editor:toggle-bold', run: F('bold'), isActive: isInline('bold') },
      { id: 'tb-italic', label: 'Italique', icon: 'italic',        group: 'format', bubble: true, commandId: 'editor:toggle-italics', run: F('italic'), isActive: isInline('italic') },
      { id: 'tb-strike', label: 'Barré',    icon: 'strikethrough', group: 'format', bubble: true, commandId: 'editor:toggle-strikethrough', run: F('strike'), isActive: isInline('strike') },
      { id: 'tb-code',   label: 'Code',     icon: 'code',          group: 'format', bubble: true, commandId: 'editor:toggle-code', run: F('code'), isActive: isInline('code') },
      // Surlignage : couleur du theme, ou l'une des six couleurs d'Obsidian.
      {
        id: 'tb-highlight', label: 'Surligner', icon: 'highlighter', group: 'format', bubble: true,
        commandId: 'editor:toggle-highlight', run: highlightIn(), isActive: isInline('highlight'),
        itemsLayout: 'palette',
        items: [
          { id: 'tb-hl-default', label: 'Surligner (couleur du thème)', icon: 'highlighter', swatch: 'var(--text-highlight-bg, rgba(255, 208, 0, 0.4))', commandId: 'editor:toggle-highlight', run: highlightIn() },
          ...PLUME_COLORS.map(c => ({
            id: `tb-hl-${c.color}`, label: `Surligner en ${c.label.toLowerCase()}`, icon: 'highlighter',
            swatch: PLUME_COLOR_VALUES[c.color].highlight,
            commandId: `editor:highlight-${c.color}`, run: highlightIn(c.color),
          })),
        ],
      },
      // Couleur du texte : toute la ligne, marquee par `🔴` en debut de ligne.
      {
        id: 'tb-text-color', label: 'Couleur du texte', icon: 'baseline', group: 'format', bubble: true,
        run: colorIn(null), itemsLayout: 'palette',
        items: [
          { id: 'tb-color-none', label: 'Couleur par défaut', icon: 'ban', commandId: 'editor:text-color-none', run: colorIn(null) },
          ...PLUME_COLORS.map(c => ({
            id: `tb-color-${c.color}`, label: `Texte ${c.label.toLowerCase()}`, icon: 'baseline',
            swatch: PLUME_COLOR_VALUES[c.color].text,
            commandId: `editor:text-color-${c.color}`, run: colorIn(c.color),
          })),
        ],
      },

      { id: 'tb-ul',   label: 'Liste à puces',   icon: 'list',         group: 'liste', commandId: 'editor:toggle-bullet-list', run: F('ul'), isActive: isList('ul') },
      { id: 'tb-ol',   label: 'Liste numérotée', icon: 'list-ordered', group: 'liste', commandId: 'editor:toggle-numbered-list', run: F('ol'), isActive: isList('ol') },
      { id: 'tb-task', label: 'Liste de tâches', icon: 'list-checks',  group: 'liste', commandId: 'editor:toggle-checklist', run: F('tasklist'), isActive: isList('tasklist') },

      { id: 'tb-link',  label: 'Lien',  icon: 'link',  group: 'insert', bubble: true, commandId: 'editor:insert-link', run: F('link') },
      { id: 'tb-image', label: 'Image', icon: 'image', group: 'insert', run: F('image') },

      // Menu « Insérer » : ce qu'on pose une fois, pas ce qu'on bascule.
      { id: 'tb-table',     label: 'Tableau',      icon: 'table',       menu: 'insert', commandId: 'editor:insert-table', run: F('table') },
      { id: 'tb-codeblock', label: 'Bloc de code', icon: 'square-code', menu: 'insert', commandId: 'editor:insert-codeblock', run: F('codeblock') },
      { id: 'tb-quote',     label: 'Citation',     icon: 'text-quote',  menu: 'insert', commandId: 'editor:toggle-blockquote', run: F('blockquote') },
      { id: 'tb-callout',   label: 'Encadré',      icon: 'info',        menu: 'insert', run: ctx => insertCallout(hostOf(viewOf(ctx) ?? this.view)) },
      { id: 'tb-hr',        label: 'Séparateur',   icon: 'minus',       menu: 'insert', run: F('hr') },
    ]
    for (const cmd of toolbarCmds) toolbar.register(cmd)

    for (const cmd of plumeCommands()) this.pluginAPI.commands.register(cmd)

    // Export PDF : la note entiere rendue puis imprimee (PdfExport.ts).
    const exportPdf = (view: EditorView | null | undefined) => {
      const v = view ?? this.view
      const path = this.pluginAPI.workspace?.getActiveDocument?.()?.path ?? this.activeFile ?? ''
      const title = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '')
      void printNote(v.state.doc.toString(), {
        title,
        registry: this.pluginAPI.blocks,
        hooks: this.pluginAPI.hooks,
        activeIds: new Set(this.activationMap.keys()),
      }).catch(err => console.error('[export PDF]', err))
    }
    toolbar.register({ id: 'tb-export-pdf', label: 'Exporter en PDF', icon: 'file-down', menu: 'more', commandId: 'editor:export-pdf', run: ctx => exportPdf(viewOf(ctx)) })
    this.pluginAPI.commands.register({
      id: 'editor:export-pdf',
      label: 'Exporter en PDF',
      hotkeys: [{ modifiers: ['Mod'], key: 'p' }],
      editor: true,
      run: ctx => exportPdf(viewOf(ctx)),
    })

    // Diapositives : une note `type: slides` se presente et s'exporte
    // (Slides.ts, SlideShow.ts, SlidesExport.ts). F5 comme dans PowerPoint,
    // seulement dans une presentation : ailleurs la touche garde son role.
    const isDeck = (ctx: PluginCommandContext) => isSlidesNote((viewOf(ctx) ?? this.view).state.doc.toString())
    const here = (view: EditorView) => slideIndexAt(slideDeck(view.state.doc.toString()), view.state.selection.main.head)
    const slideCommands: { id: string; label: string; icon: string; menu: 'insert' | 'more'; hotkeys?: Hotkey[]; deckOnly?: boolean; run(view: EditorView): void }[] = [
      { id: 'editor:present', label: 'Présenter (diapositives)', icon: 'presentation', menu: 'more', hotkeys: [{ modifiers: [], key: 'F5' }], deckOnly: true, run: v => this.presentSlides(v, 0) },
      { id: 'editor:present-here', label: 'Présenter à partir de cette diapositive', icon: 'presentation', menu: 'more', hotkeys: [{ modifiers: ['Shift'], key: 'F5' }], deckOnly: true, run: v => this.presentSlides(v, here(v)) },
      { id: 'editor:export-slides-pdf', label: 'Exporter les diapositives en PDF', icon: 'file-down', menu: 'more', run: v => this.exportSlides(v, 'pdf') },
      { id: 'editor:export-slides-pptx', label: 'Exporter en PowerPoint (.pptx)', icon: 'file-down', menu: 'more', run: v => this.exportSlides(v, 'pptx') },
      { id: 'editor:insert-slide', label: 'Diapositive', icon: 'gallery-horizontal-end', menu: 'insert', run: v => insertSlide(v) },
    ]
    for (const c of slideCommands) {
      if (c.id !== 'editor:present-here') {
        toolbar.register({ id: `tb-${c.id.slice('editor:'.length)}`, label: c.label, icon: c.icon, menu: c.menu, commandId: c.id, run: ctx => c.run(viewOf(ctx) ?? this.view) })
      }
      this.pluginAPI.commands.register({
        id: c.id, label: c.label, editor: true, ...(c.hotkeys ? { hotkeys: c.hotkeys } : {}),
        ...(c.deckOnly ? { isAvailable: isDeck } : {}),
        run: ctx => c.run(viewOf(ctx) ?? this.view),
      })
    }
  }

  private slideShow: SlideShowHandle | null = null

  /** Le nom de la note ouverte, sans extension. */
  private noteTitle(): string {
    const path = this.pluginAPI.workspace?.getActiveDocument?.()?.path ?? this.activeFile ?? ''
    return path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '')
  }

  /** Presente la note en diapositives, a partir de `start` (rang). */
  presentSlides(view: EditorView | null | undefined, start = 0): void {
    const v = view ?? this.view
    if (!v) return
    this.slideShow?.close()
    this.slideShow = startSlideShow(v.state.doc.toString(), {
      title: this.noteTitle(),
      start,
      registry: this.pluginAPI.blocks,
      hooks: this.pluginAPI.hooks,
      activeIds: new Set(this.activationMap.keys()),
      onExit: () => { this.slideShow = null; v.focus() },
    })
  }

  private exportSlides(view: EditorView, kind: 'pdf' | 'pptx'): void {
    const opts = {
      title: this.noteTitle(),
      registry: this.pluginAPI.blocks,
      hooks: this.pluginAPI.hooks,
      activeIds: new Set(this.activationMap.keys()),
    }
    const text = view.state.doc.toString()
    const run = kind === 'pdf' ? printSlides(text, opts) : downloadSlidesPptx(text, opts)
    void run.catch(err => console.error(`[diapositives] export ${kind}`, err))
  }


  /** Le titre de la note a change ici : le fichier prend son nom, les liens suivent. */
  private renameForTitle(title: string): void {
    // Le vault des plugins passe par le canal des deplacements (liens suivis).
    const shared = this.pluginAPI.vault as VaultAPI | undefined
    const vault = shared?.moveFiles ? shared : this.options.vault
    const from = this.activeFile
    if (!vault || !from || this.options.readOnly) return
    renameNoteForTitle(vault, from, title)
      .then(to => { if (to && this.activeFile === from) void this.openFile(to) })
      .catch(err => console.warn('[titre] fichier non renomme', err))
  }

  describeHotkey(commandId: string): string | null {
    const hotkeys = this.pluginAPI.hotkeys
    const first = hotkeys?.get(commandId)[0]
    return first && hotkeys ? hotkeys.format(first) : null
  }

  async openFile(path: string): Promise<void> {
    const changed = path !== this.activeFile
    this.activeFile = path
    if (changed && this.view) this.view.dispatch({ effects: notePathChanged.of(null) })
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
    toggleMarkdownFormat(this.targetView(), format)
  }

  /** L'editeur ou ecrire : la case de tableau ouverte, sinon la note. */
  private targetView(): EditorView {
    return focusedSubEditor(this.view) ?? this.view
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
    // Selection sur plusieurs lignes : centree sur le debut, pas a cheval.
    const sameLine = Math.abs(startCoords.top - endCoords.top) < 4
    return {
      x: sameLine ? (startCoords.left + endCoords.right) / 2 : startCoords.left + 60,
      y: startCoords.top,
      bottom: endCoords.bottom,
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

  /** Selection courante, en positions du texte. */
  getSelectionRange(): { from: number; to: number } {
    const { from, to } = this.view.state.selection.main
    return { from, to }
  }

  /** Selectionne un passage et le fait defiler a l'ecran. */
  selectRange(from: number, to: number): void {
    const len = this.view.state.doc.length
    const a = Math.max(0, Math.min(from, len))
    const b = Math.max(a, Math.min(to, len))
    this.view.dispatch({ selection: { anchor: a, head: b }, scrollIntoView: true })
    this.view.focus()
  }

  /** Remplace les passages surlignes par l'application. */
  setHighlights(ranges: readonly EditorHighlight[]): void {
    applyHighlights(this.view, ranges)
  }

  /** Remplace les marques de blocs d'une source (liste vide : les retire). */
  setBlockMarks(owner: string, marks: readonly BlockMark[]): void {
    applyBlockMarks(this.view, owner, marks)
  }

  /** Presence d'un agent sur la note (null : la retire). */
  setAgentPresence(owner: string, presence: AgentPresence | null): void {
    applyAgentPresence(this.view, owner, presence)
  }

  /** Remplace les marques pour l'IA (surlignages, epingles) ; liste vide : les retire. */
  setAiMarks(ranges: readonly AiMarkRange[]): void {
    applyAiMarks(this.view, ranges)
  }

  /** Le passage du texte visible a l'ecran (a peu pres : la partie dessinee). */
  getVisibleRange(): { from: number; to: number } {
    const ranges = this.view.visibleRanges
    if (!ranges.length) return { from: 0, to: 0 }
    return { from: ranges[0].from, to: ranges[ranges.length - 1].to }
  }

  /** Hote des cartes de revision dans la note (null : plus de cartes). */
  setAnnotationHost(host: AnnotationHost | null): void {
    if (!host) closeAnnotations(this.view)
    setAnnotationHost(this.view, host)
  }

  /** Hote des cartes « ce que l'IA vient de changer » : qui annule, ou voir le point (null : le retire). */
  setAiChangeHost(host: AiChangeHost | null): void {
    setAiChangeHost(this.view, host)
  }

  /** Ouvre un brouillon de commentaire ou de suggestion dans la note ; false si impossible. */
  openAnnotationDraft(draft: AnnotationDraft): boolean {
    return openAnnotationDraft(this.view, draft)
  }

  /** Le document ouvert dans cet editeur. */
  getDocId(): string | undefined {
    return this.options.docId
  }

  /** Mode suggestion : la frappe devient des propositions (null : on ecrit directement). */
  setSuggestionMode(sink: SuggestionSink | null): void {
    setSuggestionSink(this.view, sink)
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

  commitTriggerInsert(from: number, triggerCharLen: number, query: string, insert: string, cursor?: number): void {
    let to = from + triggerCharLen + query.length
    // Un style de ligne (titre, liste, citation) choisi au milieu d'une ligne
    // s'applique a la ligne : la marque va au debut, a la place de l'ancienne.
    if (LINE_PREFIX_RE.test(insert)) {
      const line = this.view.state.doc.lineAt(from)
      const rest = line.text.slice(0, from - line.from) + line.text.slice(to - line.from)
      if (rest.trim()) {
        // « Mon titre /h2 » : l'espace avant le « / » part avec lui.
        if (to === line.to && from > line.from && this.view.state.sliceDoc(from - 1, from) === ' ') from--
        const current = EXISTING_PREFIX_RE.exec(line.text)!
        const at = line.from + current[1].length
        const old = current[2] ?? ''
        const keepIndent = !/^#/.test(insert)
        const start = keepIndent ? at : line.from
        this.view.dispatch({
          changes: [{ from: start, to: at + old.length, insert }, { from, to, insert: '' }],
          selection: { anchor: from - (at + old.length - start) + insert.length },
          userEvent: 'input',
        })
        this.view.focus()
        return
      }
    }
    // Un lien complet tape dans des crochets deja fermes (« /page » puis
    // [[nom]]) : les crochets fermants en place ne se doublent pas.
    if (insert.endsWith(']]') && this.view.state.sliceDoc(to, to + 2) === ']]') to += 2
    const at = cursor !== undefined && cursor >= 0 && cursor <= insert.length ? cursor : insert.length
    this.view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + at },
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

  getCommandContext(): EditorCommandContext {
    return { view: this.view }
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

  /** Relit les plugins actifs partout (options.defaultPlugins a pu grandir) et redessine. */
  refreshPlugins(): void {
    if (this.syncDefaults()) this.events.emit('pluginLoaded')
    this.view.dispatch({ effects: pluginsLoadedEffect.of(undefined) })
  }

  /** Plugins actifs partout, relus dans options.defaultPlugins ; vrai s'ils ont change. */
  private syncDefaults(): boolean {
    const ids = (this.options.defaultPlugins ?? []).filter(p => p.manifest.defaultActive).map(p => p.manifest.id)
    if (ids.length === this.defaultActiveIds.size && ids.every(id => this.defaultActiveIds.has(id))) return false
    this.defaultActiveIds = new Set(ids)
    this.rebuildActivation()
    return true
  }

  destroy(): void {
    EditorCore.live.delete(this)
    if (this.scopeDebounceTimer !== null) clearTimeout(this.scopeDebounceTimer)
    if (this.stabilizeDebounceTimer !== null) clearTimeout(this.stabilizeDebounceTimer)
    this.unsubPropertyTypes?.()
    this.options.crdt?.dispose()
    this.view.destroy()
    this.events.destroy()
  }
}

