// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// ─── Hooks ─────────────────────────────────────────────────────────────────

export type HookStage =
  | 'beforeParse'
  | 'afterParse'
  | 'beforeRender'
  | 'afterRender'
  | 'onDocumentOpen'
  | 'onDocumentSave'
  | 'onSelectionChange'

export interface HookRegistry {
  // Registration (called by plugins)
  beforeParse(hook: (source: string) => string | Promise<string>): void
  afterParse(hook: (ast: unknown) => unknown | Promise<unknown>): void
  beforeRender(hook: (ast: unknown) => unknown | Promise<unknown>): void
  afterRender(hook: (html: string) => string | Promise<string>): void
  onDocumentOpen(hook: (path: string) => void): void
  onDocumentSave(hook: (path: string) => void): void
  onSelectionChange(hook: (selection: unknown) => void): void
  /**
   * Fired by editor-core after ~2s of inactivity on a document.
   * Used by ContentIndexingService to trigger local index updates.
   */
  onDocumentStabilized(hook: (docId: string, path: string, content: string, crdtVersion?: import('./indexing').CrdtVersion) => void): void
  // Execution (called by editor-core to run the pipeline)
  runBeforeParse(source: string): Promise<string>
  // Sync variant for CM6 StateField (which must be synchronous).
  // Async hooks are ignored in this path.
  runBeforeParseSync(source: string): string
  runAfterRender(html: string): Promise<string>
  runDocumentOpen(path: string): void
  runDocumentSave(content: string): void
  runDocumentStabilized(docId: string, path: string, content: string, crdtVersion?: import('./indexing').CrdtVersion): void
}
