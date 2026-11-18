// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// ─── Widgets ─────────────────────────────────────────────────────────────

export interface Widget {
  /** Returns React.ReactNode in practice — typed unknown to avoid React dep in plugin-api. */
  render(): unknown
  dispose?(): void
}

// ─── Views ───────────────────────────────────────────────────────────────
import type { WorkspaceAPI } from './workspace'
import type { VaultAPI } from './vault'
import type { FileTypeRegistry } from './files'

export interface ViewContext {
  workspace: WorkspaceAPI
  vault: VaultAPI
  fileTypes: FileTypeRegistry
}

/** Declared by the host app or a plugin. Plugins subscribe via groupId. */
/** Place d'une vue ou d'un groupe sur mobile (voir ViewSpec.mobile). */
export type MobilePlacement = 'tab' | 'more' | 'sheet' | 'hidden'

export interface ViewGroup {
  id: string
  title: string
  icon?: string
  container: 'left' | 'right'
  /** Show a toggle button in the icon rail. */
  ribbon?: boolean
  /** Initial size in px. */
  initialSize?: number
  closable?: boolean
  /** Place this group's pane below another group's pane (by group id). */
  belowGroup?: string
  /** How members are arranged. 'tabs' (default) = dockview tab group. 'stack' = each member belowOf the previous. */
  layout?: 'tabs' | 'stack'
  /** Stamped automatically by the runtime — 'app' for host-declared groups, 'plugin' for plugin-declared groups. */
  source?: 'app' | 'plugin'
  /**
   * Place sur mobile (un ecran a la fois). Par defaut : un ecran pour la
   * gauche et le centre, le volet du bas pour la droite.
   *  - 'tab'    : un ecran, qui peut avoir son onglet dans la barre du bas ;
   *  - 'more'   : un ecran, range dans « Plus » ;
   *  - 'sheet'  : un onglet du volet du bas (outils de la note) ;
   *  - 'hidden' : absent sur mobile.
   */
  mobile?: MobilePlacement
}

export interface ViewSpec {
  id: string
  title: string
  icon?: string
  /** 'left' | 'right' | 'center'. Ignored when groupId is set. */
  container?: 'left' | 'right' | 'center'
  /** Subscribe to a host-declared group. Overrides container/tabOf/belowOf. */
  groupId?: string
  /**
   * Show a dedicated toggle button in the icon rail.
   * Works both for standalone views (no groupId) and for views inside a group —
   * in the latter case the button focuses this specific panel without switching the group.
   */
  ribbon?: boolean
  /** If set, panel is added as a tab next to this panel ID (same group). */
  tabOf?: string
  /** If set, panel is placed below this panel ID (split horizontally). */
  belowOf?: string
  /** false = no close button (permanent panel). Default: true */
  closable?: boolean
  /** Initial size in px (width for left/right). */
  initialSize?: number
  /**
   * Place sur mobile (un ecran a la fois). Par defaut : un ecran pour la
   * gauche et le centre, le volet du bas pour la droite.
   *  - 'tab'    : un ecran, qui peut avoir son onglet dans la barre du bas ;
   *  - 'more'   : un ecran, range dans « Plus » ;
   *  - 'sheet'  : un onglet du volet du bas (outils de la note) ;
   *  - 'hidden' : absent sur mobile.
   */
  mobile?: MobilePlacement
  createView(ctx: ViewContext): Widget
}

export interface ViewRegistry {
  register(spec: ViewSpec): void
  unregister(id: string): void
  getAll(): ViewSpec[]
  registerGroup(group: ViewGroup): void
  unregisterGroup(id: string): void
  getGroups(): ViewGroup[]
  /** @internal — called by PluginLoader before/after plugin.onload to tag registrations. */
  _setCurrentPlugin?(pluginId: string | undefined): void
  /** @internal — called by PluginLoader on plugin unload to remove all groups/views registered by that plugin. */
  _cleanupPlugin?(pluginId: string): void
}
