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
  /**
   * Portee du plugin, declaree par lui-meme. Defaut : 'vault'.
   *
   *  'vault'    — touche le contenu partage : il ouvre un type de fichier, ou
   *               rend des blocs dans les notes. L'activer ou le desactiver
   *               vaut pour tout le vault, donc pour tous ses membres.
   *  'personal' — ne change que l'experience de la personne (recherche,
   *               graphe...). Chacun l'active pour soi.
   *
   * Defaut prudent : un plugin qui ne se prononce pas est traite comme un
   * plugin de vault, et sa desactivation demande confirmation.
   */
  scope?: PluginScope
  /**
   * L'application ne fonctionne pas sans lui (explorateur, liste des vaults) :
   * il n'est pas desactivable.
   */
  essential?: boolean
}

export type PluginScope = 'vault' | 'personal'

export type PluginPermission =
  | 'vault:read'
  | 'vault:write'
  | 'network:*'
  | 'ui:editor'
  | 'ui:settings'
