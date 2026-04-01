// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// ─── Note scope ────────────────────────────────────────────────────────────
//
// A note can declare plugins in its frontmatter to activate them for that note only.
// Format in frontmatter:
//   plugins: plugin-table:auto, plugin-chart:lazy
//
// 'auto'  → plugin loads when the note opens (default)
// 'lazy'  → plugin loads deferred (requestIdleCallback / after first paint)
//           Use for heavy plugins (large bundles) that are not needed immediately.

export type PluginLoadStrategy = 'auto' | 'lazy'

export interface NotePluginScope {
  /** Plugin id as declared in its manifest. */
  id: string
  /** Load strategy for this note. Default: 'auto'. */
  load?: PluginLoadStrategy
}

export interface NoteScope {
  /** Plugins activated for this note. Merged on top of the editor's built-ins. */
  plugins?: NotePluginScope[]
}

// ─── Plugin lifecycle ──────────────────────────────────────────────────────

export interface PluginManifest {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  permissions?: PluginPermission[]
  /**
   * When true, this plugin is active for every note by default (no frontmatter needed).
   * When false/absent, the plugin is only active when the note explicitly activates it
   * (via frontmatter `plugins:` or file extension matching).
   */
  defaultActive?: boolean
}

export type PluginPermission =
  | 'vault:read'
  | 'vault:write'
  | 'network:*'
  | 'ui:editor'
  | 'ui:settings'
