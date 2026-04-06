// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// ─── File types ─────────────────────────────────────────────────────────
import type { VaultAPI } from './vault'
import type { ContentExtractor } from './indexing'

export interface FileContext {
  vaultId: string
  path: string
  /** Id of the current user, used for sync (DocumentRoom). */
  userId?: string
  /** VaultAPI injected so the plugin can read/write without depending on an internal import. */
  vault?: VaultAPI
  /**
   * Called by the FileView when its content is stabilized (after internal debounce).
   * The app layer converts the raw content via contentExtractor.toShadowDocument()
   * and pushes it to ContentIndexingService for local index update
   */
  onContentStabilized?: (rawContent: string) => void
}

export interface FileView {
  mount(container: HTMLElement): void
  destroy(): void
}

export interface FileTypeSpec {
  extension: string
  label: string
  icon: string
  /**
   * If false, this type does not appear in the creation picker (e.g., images).
   * The icon is still used elsewhere (file tree, tabs, etc.).
   * Default: true.
   */
  creatable?: boolean
  create(): Promise<string>
  /**
   * Opens the file in a custom view. If absent, the host editor (EditorCore) handles
   * the file — use this for types like Markdown whose editor is built into the core.
   */
  open?(path: string, ctx: FileContext): FileView
  /** Read-only rendering for ![[file.ext]] embeds in a markdown note. */
  renderEmbed?(path: string, ctx: FileContext): Promise<HTMLElement>
  /**
   * Markdown content extractor for indexing.
   * If defined, the client calls toShadowDocument() after each save
   * and pushes the result to the server for indexing.
   */
  contentExtractor?: ContentExtractor
}

export interface FileTypeRegistry {
  register(spec: FileTypeSpec): void
  unregister(extension: string): void
  /** Returns the registered spec for this extension, or undefined if none. */
  resolve(extension: string): FileTypeSpec | undefined
  /** Returns all registered file types, sorted by extension. */
  getAll(): FileTypeSpec[]
}
