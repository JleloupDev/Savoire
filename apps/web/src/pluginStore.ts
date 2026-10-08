// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Store officiel : TOUS les plugins du projet. Ecrit en dur pour l'instant ;
// demain, un index publie par un store externe.
//
//  - preinstalled : installe par defaut, charge au demarrage (le coeur) ;
//  - sinon        : disponible, son code n'est importe qu'a l'installation.
// Tout plugin non indispensable se desinstalle et revient ici.
//
// L'ordre compte : c'est l'ordre de chargement au demarrage (l'explorateur se
// place sous la liste des vaults, par exemple).
//
// Un plugin non preinstalle doit pouvoir s'afficher dans le store sans charger
// son code : son entree recopie alors son manifeste, et un test verifie que la
// copie reste fidele. Un plugin preinstalle est charge au demarrage ; le store
// lit son manifeste directement.
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
    id: 'plugin-vault-browser', preinstalled: true,
    load: async (ctx) => (await import('@savoire/plugin-vault-browser')).createVaultBrowserPlugin({
      refs: ctx.vaultBrowserRefs, groupId: 'explorer', closable: false,
    }),
  },
  {
    id: 'plugin-filetree', preinstalled: true,
    load: async () => (await import('@savoire/plugin-filetree')).createFileTreePlugin({
      groupId: 'explorer', belowOf: 'vault-browser', closable: false,
    }),
  },
  {
    id: 'plugin-wikilinks', preinstalled: true,
    load: async () => (await import('@savoire/plugin-wikilinks')).createWikilinksPlugin({ groupId: 'notes-tools' }),
  },
  {
    id: 'plugin-hashtags', preinstalled: true,
    load: async () => (await import('@savoire/plugin-hashtags')).createHashtagsPlugin({
      container: 'left', ribbon: true, icon: 'tag',
    }),
  },
  {
    id: 'plugin-metadata', preinstalled: true,
    load: async () => (await import('@savoire/plugin-metadata')).createMetadataPlugin({ groupId: 'notes-tools' }),
  },
  {
    // Pas de groupId : le graphe s'ouvre comme vue principale (onglet a cote
    // de l'editeur), depuis la barre d'icones de gauche.
    id: 'plugin-graph', preinstalled: true,
    load: async (ctx) => {
      const { plugin, getContributor } = (await import('@savoire/plugin-graph')).createGraphPlugin()
      ctx.setGraphContributor(getContributor)
      return plugin
    },
  },
  {
    id: 'plugin-search', preinstalled: true,
    load: async () => (await import('@savoire/plugin-search')).createSearchPlugin({ container: 'left', ribbon: true }).plugin,
  },

  // ── Coeur : types de fichiers ──────────────────────────────────────────────
  { id: 'plugin-excalidraw', preinstalled: true, load: async () => (await import('@savoire/plugin-excalidraw')).default },
  { id: 'plugin-mindmap', preinstalled: true, load: async () => (await import('@savoire/plugin-mindmap')).default },
  { id: 'plugin-office', preinstalled: true, load: async () => (await import('@savoire/plugin-office')).default },

  // ── Coeur : edition (blocs, actifs dans toutes les notes) ──────────────────
  { id: 'plugin-mermaid', preinstalled: true, editorDefault: true, load: async () => (await import('@savoire/plugin-mermaid')).default },
  { id: 'plugin-callout', preinstalled: true, editorDefault: true, load: async () => (await import('@savoire/plugin-callout')).default },
  { id: 'plugin-code-block', preinstalled: true, editorDefault: true, load: async () => (await import('@savoire/plugin-code-block')).default },
  { id: 'plugin-note-embed', preinstalled: true, editorDefault: true, load: async () => (await import('@savoire/plugin-note-embed')).default },
  { id: 'plugin-module', preinstalled: true, editorDefault: true, load: async () => (await import('@savoire/plugin-module')).default },
  { id: 'plugin-task-list', preinstalled: true, editorDefault: true, load: async () => (await import('@savoire/plugin-task-list')).default },
  { id: 'plugin-table', preinstalled: true, editorDefault: true, load: async () => (await import('@savoire/plugin-table')).default },

  // ── Coeur : agents ─────────────────────────────────────────────────────────
  { id: 'plugin-agent-reviewer', preinstalled: true, load: async () => (await import('@savoire/plugin-agent-reviewer')).default },

  // ── Disponibles ────────────────────────────────────────────────────────────
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
    id: 'plugin-backlinks', preinstalled: false,
    manifest: {
      id: 'plugin-backlinks',
      scope: 'vault',
      name: 'Backlinks',
      version: '0.0.1',
      description: 'Indexe les backlinks (vue fournie par plugin-wikilinks).',
      permissions: ['vault:read'],
    },
    extensions: [],
    load: async () => (await import('@savoire/plugin-backlinks')).createBacklinksPlugin(),
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
