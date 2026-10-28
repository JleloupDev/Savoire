// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// ─── Plugin API surface ───────────────────────────────────────────────────
//
// Two ports are exposed by the application layer (both implemented by PluginAPIImpl):
//   - PluginAPI        → restricted interface received by plugins
//   - IEditorHostAPI   → privileged interface received by EditorCore as host
//
// Defined here so editor-core can import without depending on plugin-runtime.

import type { PluginManifest } from './manifest'
import type { VaultAPI } from './vault'
import type { WorkspaceAPI } from './workspace'
import type { CommandRegistry, HotkeyAPI, HotkeyHost } from './commands'
import type { HookRegistry } from './hooks'
import type { BlockRegistry } from './blocks'
import type { FileTypeRegistry } from './files'
import type { ViewRegistry } from './views'
import type { SlashRegistry, TriggerRegistry } from './triggers'
import type { EditorPositionAPI, ToolbarCommandRegistry } from './editor'
import type { SyncAPI } from './sync'
import type { AgentRegistry } from './agents'
import type { IPluginIndexAPI } from './indexing'
import type { IQueryEngine } from './query'
import type { ISearchEngine } from './search'

export interface IPluginVaultAPI extends VaultAPI {}
export interface IPluginWorkspaceAPI extends WorkspaceAPI {}
export interface IPluginCommandsAPI extends CommandRegistry {}
export interface IPluginViewsAPI extends ViewRegistry {}
export interface IPluginBlocksAPI extends BlockRegistry {}
export interface IPluginHooksAPI extends HookRegistry {}
export interface IPluginSlashAPI extends SlashRegistry {}
export interface IPluginTriggersAPI extends TriggerRegistry {}
export interface IPluginEditorAPI extends EditorPositionAPI {}
export interface IPluginToolbarAPI extends ToolbarCommandRegistry {}

export interface IPluginAPI {
  commands: IPluginCommandsAPI
  hooks: IPluginHooksAPI
  blocks: IPluginBlocksAPI
  files: FileTypeRegistry
  vault: IPluginVaultAPI
  workspace: IPluginWorkspaceAPI
  views: IPluginViewsAPI
  slash: IPluginSlashAPI
  triggers: IPluginTriggersAPI
  editor: IPluginEditorAPI
  toolbar: IPluginToolbarAPI
  /** Sync temps réel format-agnostic (DocumentRoom / /hubs/room). Absent si non configuré. */
  sync?: SyncAPI
  /** Index local — enregistrement de contributeurs (backlinks, tags…). */
  index?: IPluginIndexAPI
  /** Agents proposes par le plugin (permission 'agents'). Voir agents.ts. */
  agents?: AgentRegistry
  /** Moteur de raccourcis clavier : lire et changer les touches des commandes. */
  hotkeys?: HotkeyAPI
  /** Requetes sur les notes du vault (bases, listes, proprietes). Voir query.ts.
   *  Permission 'vault:read'. Absent si aucun index n'est disponible. */
  query?: IQueryEngine
  /** Recherche plein texte dans le vault. Voir search.ts.
   *  Permission 'vault:read'. Absent si aucun index n'est disponible. */
  search?: ISearchEngine
}

export interface PluginAPI extends IPluginAPI {}

// ─── Plugin lifecycle ─────────────────────────────────────────────────────

export interface VaultPlugin {
  manifest: PluginManifest
  onload(api: PluginAPI): Promise<void>
  onunload(): Promise<void>
}

// ─── Editor host API ──────────────────────────────────────────────────────
//
// The privileged interface received by EditorCore as the plugin system host.
// Extends PluginAPI — the host has all plugin capabilities plus privileged methods.
// Both are implemented by PluginAPIImpl in plugin-runtime.

export interface IEditorHostAPI extends PluginAPI {
  /** Post-construction wiring: EditorCore registers itself as the cursor/selection provider. */
  setEditorPositionAPI(api: EditorPositionAPI): void
  /** L'editeur lui passe les touches pressees quand il a le focus. */
  hotkeys?: HotkeyHost
}

// ─── Plugin loader abstraction ────────────────────────────────────────────

export interface IPluginLoader {
  loadInternal(plugin: VaultPlugin, api: PluginAPI): Promise<void>
  getLoadedIds(): string[]
}
