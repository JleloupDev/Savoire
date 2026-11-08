// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Store officiel : TOUS les plugins du projet. Ecrit en dur pour l'instant ;
// demain, un index publie par un store externe.
//
//  - core         : plugin core, livre avec Savoire (comme les plugins core
//                   d'Obsidian) : toujours installe et charge au demarrage,
//                   il s'active ou se desactive, il ne se desinstalle pas ;
//  - preinstalled : plugin de la communaute installe par defaut ;
//  - sinon        : disponible, son code n'est importe qu'a l'installation.
// Un plugin de la communaute se desinstalle et revient ici.
//
// L'ordre compte : c'est l'ordre de chargement au demarrage (l'explorateur se
// place sous la liste des vaults, par exemple).
//
// Un plugin non preinstalle doit pouvoir s'afficher dans le store sans charger
// son code : son entree recopie alors son manifeste, et un test verifie que la
// copie reste fidele. Un plugin preinstalle est charge au demarrage ; le store
// lit son manifeste directement.
import { boardFrameUrl } from './tauriRuntime'
import type { PluginManifest, VaultPlugin } from '@savoire/plugin-api'
import type { VaultBrowserRefs } from '@savoire/plugin-vault-browser'
import type { GraphIndexContributor } from '@savoire/plugin-graph'
import type { VaultSummary } from './types'

/** Ce dont certains plugins du coeur ont besoin pour se construire. */
export interface PluginLoadContext {
  vaultBrowserRefs: VaultBrowserRefs<VaultSummary>
  setGraphContributor(get: () => GraphIndexContributor | null): void
}

export interface StoreEntry {
  id: string
  preinstalled: boolean
  /** Plugin core (toujours preinstalle) : desactivable, pas desinstallable. */
  core?: boolean
  /** Plugin d'edition actif par defaut dans toutes les notes (ADR-012). */
  editorDefault?: boolean
  /** Manifeste recopie, pour afficher le plugin sans charger son code. */
  manifest?: PluginManifest
  /** Extensions de fichier que le plugin ouvre : pour proposer de l'installer. */
  extensions?: string[]
  load(ctx: PluginLoadContext): Promise<VaultPlugin>
}

export const STORE_CATALOG: StoreEntry[] = [
  // ── Coeur : workspace ──────────────────────────────────────────────────────
  {
    id: 'plugin-vault-browser', preinstalled: true, core: true,
    load: async (ctx) => (await import('@savoire/plugin-vault-browser')).createVaultBrowserPlugin({
      refs: ctx.vaultBrowserRefs, groupId: 'explorer', closable: false,
    }),
  },
  {
    id: 'plugin-filetree', preinstalled: true, core: true,
    load: async () => (await import('@savoire/plugin-filetree')).createFileTreePlugin({
      groupId: 'explorer', belowOf: 'vault-browser', closable: false,
    }),
  },
  {
    id: 'plugin-wikilinks', preinstalled: true, core: true,
    load: async () => (await import('@savoire/plugin-wikilinks')).createWikilinksPlugin(),
  },
  {
    // Apres plugin-wikilinks : le panneau lit son index des liens.
    id: 'plugin-backlinks', preinstalled: true, core: true,
    load: async () => (await import('@savoire/plugin-backlinks')).createBacklinksPlugin({ groupId: 'notes-tools' }),
  },
  {
    id: 'plugin-hashtags', preinstalled: true, core: true,
    load: async () => (await import('@savoire/plugin-hashtags')).createHashtagsPlugin({
      container: 'left', ribbon: true, icon: 'tag',
    }),
  },
  {
    id: 'plugin-metadata', preinstalled: true, core: true,
    load: async () => (await import('@savoire/plugin-metadata')).createMetadataPlugin({ groupId: 'notes-tools' }),
  },
  {
    // Pas de groupId : le graphe s'ouvre comme vue principale (onglet a cote
    // de l'editeur), depuis la barre d'icones de gauche.
    id: 'plugin-graph', preinstalled: true, core: true,
    load: async (ctx) => {
      const { plugin, getContributor } = (await import('@savoire/plugin-graph')).createGraphPlugin()
      ctx.setGraphContributor(getContributor)
      return plugin
    },
  },
  {
    id: 'plugin-search', preinstalled: true, core: true,
    load: async () => (await import('@savoire/plugin-search')).createSearchPlugin({ container: 'left', ribbon: true }).plugin,
  },

  // ── Communaute, installes par defaut : types de fichiers ───────────────────
  { id: 'plugin-excalidraw', preinstalled: true, load: async () => (await import('@savoire/plugin-excalidraw')).default },
  { id: 'plugin-mindmap', preinstalled: true, load: async () => (await import('@savoire/plugin-mindmap')).default },

  // Communaute, installe par defaut : diagrammes dans les notes.
  { id: 'plugin-mermaid', preinstalled: true, editorDefault: true, load: async () => (await import('@savoire/plugin-mermaid')).default },

  // ── Coeur : edition (blocs, actifs dans toutes les notes) ──────────────────
  { id: 'plugin-callout', preinstalled: true, core: true, editorDefault: true, load: async () => (await import('@savoire/plugin-callout')).default },
  { id: 'plugin-code-block', preinstalled: true, core: true, editorDefault: true, load: async () => (await import('@savoire/plugin-code-block')).default },
  { id: 'plugin-note-embed', preinstalled: true, core: true, editorDefault: true, load: async () => (await import('@savoire/plugin-note-embed')).default },
  { id: 'plugin-module', preinstalled: true, core: true, editorDefault: true, load: async () => (await import('@savoire/plugin-module')).default },
  { id: 'plugin-task-list', preinstalled: true, core: true, editorDefault: true, load: async () => (await import('@savoire/plugin-task-list')).default },
  { id: 'plugin-table', preinstalled: true, core: true, editorDefault: true, load: async () => (await import('@savoire/plugin-table')).default },
  { id: 'plugin-templates', preinstalled: true, core: true, load: async () => (await import('@savoire/plugin-templates')).default },
  { id: 'plugin-agenda', preinstalled: true, core: true, load: async () => (await import('@savoire/plugin-agenda')).createAgendaPlugin() },
  { id: 'plugin-history', preinstalled: true, core: true, load: async () => (await import('@savoire/plugin-history')).createHistoryPlugin() },

  // ── Disponibles ────────────────────────────────────────────────────────────
  {
    id: 'plugin-office', preinstalled: false,
    manifest: {
      id: 'plugin-office',
      scope: 'vault',
      name: 'Documents Office liés',
      version: '0.0.1',
      description: 'Word, Excel, PowerPoint et OpenDocument : un lien vers le document en ligne',
      permissions: ['ui:editor', 'vault:read', 'vault:write'],
      defaultActive: true,
    },
    extensions: ['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp'],
    load: async () => (await import('@savoire/plugin-office')).default,
  },
  {
    id: 'plugin-agent-reviewer', preinstalled: false,
    manifest: {
      id: 'plugin-agent-reviewer',
      name: 'Agent Relecteur',
      version: '0.0.1',
      description: 'Un agent qui relit la note : mots, TODO, liens cassés',
      scope: 'personal',
      permissions: ['agents'],
    },
    extensions: [],
    load: async () => (await import('@savoire/plugin-agent-reviewer')).default,
  },
  {
    id: 'plugin-plaintext', preinstalled: false,
    manifest: {
      id: 'plugin-plaintext',
      scope: 'vault',
      name: 'Plaintext Editor',
      version: '0.0.1',
      description: 'Éditeur textarea simple pour les fichiers .txt — POC FileTypeSpec',
      permissions: ['ui:editor', 'vault:read', 'vault:write'],
    },
    extensions: ['txt'],
    load: async () => (await import('@savoire/plugin-plaintext')).default,
  },
  {
    id: 'plugin-chat', preinstalled: false,
    manifest: {
      id: 'plugin-chat',
      name: 'Discussions',
      version: '0.0.1',
      description: 'Des discussions en direct entre les membres du vault (fichiers .chat)',
      scope: 'vault',
      permissions: ['ui:editor'],
    },
    extensions: ['chat'],
    load: async () => (await import('@savoire/plugin-chat')).default,
  },
  {
    id: 'plugin-outline', preinstalled: false,
    manifest: {
      id: 'plugin-outline',
      name: 'Plans',
      version: '0.0.1',
      description: 'Des plans à la Workflowy : listes imbriquées, pliage, zoom (fichiers .outline)',
      scope: 'vault',
      permissions: ['ui:editor'],
    },
    extensions: ['outline'],
    load: async () => (await import('@savoire/plugin-outline')).default,
  },
  {
    id: 'plugin-page', preinstalled: false,
    manifest: {
      id: 'plugin-page',
      name: 'Pages',
      version: '0.0.1',
      description: 'Des pages facon Notion : blocs, menu /, sous-pages (fichiers .page)',
      scope: 'vault',
      permissions: ['ui:editor'],
    },
    extensions: ['page'],
    load: async () => (await import('@savoire/plugin-page')).default,
  },
  {
    // editorDefault : ses blocs (requete ```base, ![[x.base]]) vivent dans les notes.
    id: 'plugin-base', preinstalled: true, core: true, editorDefault: true,
    manifest: {
      id: 'plugin-base',
      name: 'Bases',
      version: '0.0.1',
      description: 'Des bases façon Notion : tableau, kanban, propriétés typées (fichiers .base)',
      scope: 'vault',
      permissions: ['ui:editor', 'vault:read', 'vault:write'],
      defaultActive: true,
    },
    extensions: ['base'],
    load: async () => (await import('@savoire/plugin-base')).default,
  },
  {
    // editorDefault : ![[x.board]] s'affiche dans les notes.
    id: 'plugin-board', preinstalled: true, core: true, editorDefault: true,
    manifest: {
      id: 'plugin-board',
      name: 'Boards',
      version: '0.0.1',
      description: 'Des mini applis en HTML, CSS et JavaScript qui interrogent les bases (fichiers .board)',
      scope: 'vault',
      permissions: ['ui:editor', 'vault:read', 'vault:write'],
      defaultActive: true,
    },
    extensions: ['board'],
    load: async () => {
      const mod = await import('@savoire/plugin-board')
      // Bureau : le cadre du board a sa propre CSP (celle de la fenetre bloque le JS en ligne).
      mod.setBoardFrameUrl(boardFrameUrl())
      return mod.default
    },
  },
  {
    id: 'plugin-quickref', preinstalled: false,
    manifest: {
      id: 'plugin-quickref',
      name: 'QuickRef',
      version: '0.0.1',
      description: 'Citer la Bible : « ! » puis un livre, un chapitre ou un mot insère les versets',
      scope: 'vault',
      permissions: ['ui:editor', 'vault:read'],
      defaultActive: true,
    },
    extensions: [],
    load: async () => (await import('@savoire/plugin-quickref')).default,
  },
  {
    id: 'plugin-wtf', preinstalled: false,
    manifest: {
      id: 'plugin-wtf',
      name: 'WTF (test)',
      version: '0.0.1',
      description: 'Plugin de test : des fichiers .wtf qui sont du simple Markdown',
      scope: 'vault',
      permissions: ['ui:editor'],
      defaultActive: true,
    },
    extensions: ['wtf'],
    load: async () => (await import('@savoire/plugin-wtf')).default,
  },
]
