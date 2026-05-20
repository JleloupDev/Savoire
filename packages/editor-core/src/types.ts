// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Public types for EditorCore — no React dependency allowed.

import type { TriggerActivation, ToolbarCommand } from '@savoire/plugin-api'

export type EditorEvent =
  | 'documentChanged'
  | 'cursorMoved'
  | 'selectionChanged'
  | 'fileOpened'
  | 'fileSaved'
  | 'pluginLoaded'

export type MarkdownFormat =
  | 'bold' | 'italic' | 'strike' | 'code'
  | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
  | 'ul' | 'ol' | 'blockquote'
  | 'link' | 'hr'

/** Screen coordinates of the mid-top of a selection or cursor position. */
export interface SelectionCoords {
  x: number
  y: number
}

// Re-export for consumers that import from editor-core
export type { TriggerActivation, ToolbarCommand }

/** Info about a plugin active for the current note. */
export interface ActivePluginInfo {
  id: string
  /** 'default' = manifest.defaultActive. 'extension' = file extension. 'frontmatter' = note frontmatter. */
  source: 'default' | 'extension' | 'frontmatter'
}

export interface EditorController {
  openFile(path: string): Promise<void>
  save(): Promise<void>
  executeCommand(id: string): void
  /** Toggle a Markdown formatting action on the current selection / line. */
  toggleFormat(format: MarkdownFormat): void
  getActiveFile(): string | null
  getConnectionStatus(): 'connected' | 'connecting' | 'disconnected'
  exportMarkdown(): string
  destroy(): void
  on(event: EditorEvent, handler: (...args: unknown[]) => void): () => void
  /** Returns screen coords of the current selection midpoint, or null if no selection. */
  getSelectionCoords(): SelectionCoords | null
  /** Returns the currently selected text, or empty string if no selection. */
  getSelectionText(): string
  /** Returns the active trigger activation if cursor is right after a trigger character, else null. */
  getActiveTrigger(): TriggerActivation | null
  /** Replace trigger+query at `from` with `insert` and focus the editor. */
  commitTriggerInsert(from: number, triggerCharLen: number, query: string, insert: string): void
  /** Returns all toolbar commands registered by plugins and built-ins. */
  getToolbarCommands(): ToolbarCommand[]
  /** Run a toolbar command by id (ctx is created internally — React never sees it). */
  runToolbarCommand(id: string): void
  /** Insert text at the current cursor position and focus the editor. */
  insertText(text: string): void
  /** Returns the list of scoped plugins active for this note (loaded from extension or frontmatter). */
  getActivePlugins(): ActivePluginInfo[]
}

import type { Extension } from '@codemirror/state'
import type { ICRDT, VaultAPI, NoteScope } from '@savoire/plugin-api'

export interface ICodeMirrorCRDT extends ICRDT {
  getExtensions(): Extension[]
}

export interface EditorCoreOptions {
  container: HTMLElement
  /** Provide to enable collaborative editing — omit for offline mode. */
  crdt?: ICodeMirrorCRDT
  /** Delegate to the active ITransport.getState() for connection status reporting. */
  getTransportState?: () => 'connected' | 'connecting' | 'disconnected'
  docId?: string
  userId?: string
  initialContent?: string
  /** Vault implementation for plugins (read/write files). Defaults to no-op stub. */
  vault?: VaultAPI
  /** When true, the editor is read-only (EditorState.readOnly + EditorView.editable). */
  readOnly?: boolean
  /** When false, hides the line-number gutter. Defaults to true. */
  showLineNumbers?: boolean
  /**
   * Path of the file being edited (e.g. "notes/drawing.excalidraw").
   * When provided, EditorCore derives the extension and auto-loads the matching
   * plugin from pluginRegistry — no frontmatter required for file-type plugins.
   */
  filePath?: string
  /**
   * External plugin registry: pluginId → async factory.
   * Resolved when frontmatter declares `plugins: <id>:auto` or when the file
   * extension matches. Keeps editor-core free of optional plugin dependencies.
   */
  pluginRegistry?: Record<string, () => Promise<import('@savoire/plugin-api').VaultPlugin>>
  /**
   * Note-level plugin scope parsed from the note's frontmatter.
   * If omitted, EditorCore parses it from initialContent automatically.
   */
  scope?: NoteScope
  /**
   * Plugins active for every note by default. Passed by the app layer — EditorCore
   * no longer hardcodes any plugin imports. Plugins with manifest.defaultActive=true
   * are included in the initial activation set and render without any frontmatter.
   */
  defaultPlugins?: import('@savoire/plugin-api').VaultPlugin[]
  /**
   * Shared PluginAPIImpl created by the app layer (EditorPage). When provided,
   * EditorCore reuses the registries (blocks, hooks, slash…) and skips loading
   * defaultPlugins itself — they are already loaded by the caller.
   * see ADR-008
   */
  pluginAPI?: import('@savoire/plugin-api').IEditorHostAPI
  /**
   * Factory for the per-document plugin loader (note-scoped plugins).
   * Injected by the app layer so editor-core has no direct dependency on plugin-runtime.
   * Defaults to a noop loader when omitted (standalone / playground mode).
   */
  createPluginLoader?: () => import('@savoire/plugin-api').IPluginLoader
}
