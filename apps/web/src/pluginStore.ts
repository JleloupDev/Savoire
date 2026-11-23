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
import { sandboxFrameUrl } from './tauriRuntime'
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
  /** Anciens ids (plugin renomme) : leur reglage de vault est repris. */
  formerIds?: string[]
  /** Paquet du Savoire Store (code signe, telecharge), pas livre avec Savoire. */
  fromStore?: boolean
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
    // Liens [[...]] et panneau des retroliens (ancien plugin-backlinks).
    id: 'plugin-wikilinks', preinstalled: true, core: true,
    load: async () => (await import('@savoire/plugin-wikilinks')).createWikilinksPlugin({ backlinks: { groupId: 'notes-tools' } }),
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

  // ── Coeur : edition et outils (blocs actifs dans toutes les notes) ───────
  { id: 'plugin-callout', preinstalled: true, core: true, editorDefault: true, load: async () => (await import('@savoire/plugin-callout')).default },
  { id: 'plugin-code-block', preinstalled: true, core: true, editorDefault: true, load: async () => (await import('@savoire/plugin-code-block')).default },
  { id: 'plugin-note-embed', preinstalled: true, core: true, editorDefault: true, load: async () => (await import('@savoire/plugin-note-embed')).default },
  { id: 'plugin-module', preinstalled: true, core: true, editorDefault: true, load: async () => (await import('@savoire/plugin-module')).default },
  { id: 'plugin-task-list', preinstalled: true, core: true, editorDefault: true, load: async () => (await import('@savoire/plugin-task-list')).default },
  { id: 'plugin-table', preinstalled: true, core: true, editorDefault: true, load: async () => (await import('@savoire/plugin-table')).default },
  { id: 'plugin-footnotes', preinstalled: true, core: true, editorDefault: true, load: async () => (await import('@savoire/plugin-footnotes')).default },
  { id: 'plugin-templates', preinstalled: true, core: true, load: async () => (await import('@savoire/plugin-templates')).default },
  { id: 'plugin-agenda', preinstalled: true, core: true, load: async () => (await import('@savoire/plugin-agenda')).createAgendaPlugin() },
  { id: 'plugin-history', preinstalled: true, core: true, load: async () => (await import('@savoire/plugin-history')).createHistoryPlugin() },

  // ── Coeur : types Savoire ──────────────────────────────────────────────────
  {
    // editorDefault : ses blocs (requete ```base, ![[x.base]]) vivent dans les notes.
    id: 'plugin-base', preinstalled: true, core: true, editorDefault: true,
    manifest: {
      id: 'plugin-base',
      name: 'Bases',
      version: '0.0.1',
      description: 'Des bases façon Notion : tableau, kanban, propriétés typées (fichiers .base)',
      scope: 'vault',
      permissions: ['ui:editor', 'vault:read', 'vault:write', 'agents'],
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
      mod.setBoardFrameUrl(sandboxFrameUrl())
      return mod.default
    },
  },

  // ── Store : a installer ────────────────────────────────────────────────────
  // Documents existants : un plugin par type (son indexeur se desactive avec lui).
  // Verifies par l'equipe Savoire (official) : ils tournent aussi sur le pair indexeur.
  {
    id: 'plugin-word', preinstalled: false,
    manifest: {
      id: 'plugin-word',
      trust: 'verified',
      name: 'Documents Word',
      version: '0.0.1',
      description: 'Le texte des documents Word (.docx) dans la recherche, et leur aperçu',
      scope: 'vault',
      permissions: ['ui:editor', 'vault:read'],
      defaultActive: true,
      official: true,
    },
    extensions: [],
    load: async () => (await import('@savoire/plugin-word')).default,
  },
  {
    id: 'plugin-powerpoint', preinstalled: false,
    manifest: {
      id: 'plugin-powerpoint',
      trust: 'verified',
      name: 'Présentations PowerPoint',
      version: '0.0.1',
      description: 'Le texte des présentations PowerPoint (.pptx) dans la recherche, et leur aperçu',
      scope: 'vault',
      permissions: ['ui:editor', 'vault:read'],
      defaultActive: true,
      official: true,
    },
    extensions: [],
    load: async () => (await import('@savoire/plugin-powerpoint')).default,
  },
  {
    id: 'plugin-excel', preinstalled: false,
    manifest: {
      id: 'plugin-excel',
      trust: 'verified',
      name: 'Classeurs Excel',
      version: '0.0.1',
      description: 'Le contenu des classeurs Excel (.xlsx) dans la recherche, et leur aperçu en tableaux',
      scope: 'vault',
      permissions: ['ui:editor', 'vault:read'],
      defaultActive: true,
      official: true,
    },
    extensions: [],
    load: async () => (await import('@savoire/plugin-excel')).default,
  },
  {
    id: 'plugin-opendocument', preinstalled: false,
    manifest: {
      id: 'plugin-opendocument',
      trust: 'verified',
      name: 'Documents LibreOffice',
      version: '0.0.1',
      description: 'Le contenu des documents LibreOffice (.odt, .ods, .odp) dans la recherche, et leur aperçu',
      scope: 'vault',
      permissions: ['ui:editor', 'vault:read'],
      defaultActive: true,
      official: true,
    },
    extensions: [],
    load: async () => (await import('@savoire/plugin-opendocument')).default,
  },
  {
    id: 'plugin-pdf', preinstalled: false,
    manifest: {
      id: 'plugin-pdf',
      trust: 'verified',
      name: 'PDF',
      version: '0.0.1',
      description: 'Le texte des PDF dans la recherche, et leur aperçu',
      scope: 'vault',
      permissions: ['ui:editor', 'vault:read'],
      defaultActive: true,
      official: true,
    },
    extensions: ['pdf'],
    load: async () => (await import('@savoire/plugin-pdf')).default,
  },
  {
    id: 'plugin-images', preinstalled: false,
    manifest: {
      id: 'plugin-images',
      trust: 'verified',
      name: 'Images',
      version: '0.0.1',
      description: 'Les images dans la recherche : dimensions, date, appareil, et le texte qu’elles contiennent (OCR)',
      scope: 'vault',
      permissions: ['vault:read'],
      defaultActive: true,
      official: true,
    },
    extensions: [],
    load: async () => (await import('@savoire/plugin-images')).default,
  },
  {
    // Videos et sons : lecteur, et ![[x.mp4]] dans les notes.
    id: 'plugin-video', preinstalled: false, editorDefault: true,
    manifest: {
      id: 'plugin-video',
      trust: 'verified',
      name: 'Vidéos et sons',
      version: '0.0.1',
      description: 'Lire les vidéos et les sons du vault, et les intégrer dans les notes : ![[Démo.mp4]]',
      scope: 'vault',
      permissions: ['ui:editor', 'vault:read'],
      defaultActive: true,
    },
    extensions: ['mp4', 'm4v', 'webm', 'mov', 'ogv', 'mp3', 'wav', 'ogg', 'oga', 'm4a', 'flac'],
    load: async () => (await import('@savoire/plugin-video')).default,
  },
  {
    id: 'plugin-webpage', preinstalled: false,
    manifest: {
      id: 'plugin-webpage',
      trust: 'verified',
      name: 'Pages web',
      version: '0.0.1',
      description: 'Les pages web (.html) : leur texte dans la recherche, un aperçu sans script',
      scope: 'vault',
      permissions: ['ui:editor', 'vault:read'],
      defaultActive: true,
      official: true,
    },
    extensions: ['html', 'htm'],
    load: async () => (await import('@savoire/plugin-webpage')).default,
  },
  {
    id: 'plugin-csv', preinstalled: false,
    manifest: {
      id: 'plugin-csv',
      trust: 'verified',
      name: 'Tableaux CSV',
      version: '0.0.1',
      description: 'Les fichiers CSV : leur contenu dans la recherche, un aperçu en tableau',
      scope: 'vault',
      permissions: ['ui:editor', 'vault:read'],
      defaultActive: true,
      official: true,
    },
    extensions: ['csv', 'tsv'],
    load: async () => (await import('@savoire/plugin-csv')).default,
  },
  // Communaute : dessins, cartes mentales, diagrammes.
  {
    id: 'plugin-excalidraw', preinstalled: false,
    manifest: {
      id: 'plugin-excalidraw',
      name: 'Excalidraw',
      version: '0.0.2',
      description: 'Éditeur de dessin vectoriel Excalidraw pour les fichiers .excalidraw',
      scope: 'vault',
      permissions: ['ui:editor', 'vault:read', 'vault:write', 'agents'],
      defaultActive: false,
      trust: 'verified',
    },
    extensions: ['excalidraw'],
    load: async () => (await import('@savoire/plugin-excalidraw')).default,
  },
  {
    id: 'plugin-mindmap', preinstalled: false,
    manifest: {
      id: 'plugin-mindmap',
      trust: 'verified',
      name: 'Mind Map',
      version: '0.0.2',
      description: 'Éditeur de mind maps interactif pour les fichiers .mm',
      scope: 'vault',
      permissions: ['ui:editor', 'vault:read', 'vault:write'],
      defaultActive: false,
    },
    extensions: ['mm'],
    load: async () => (await import('@savoire/plugin-mindmap')).default,
  },
  {
    // editorDefault : une fois installe, actif dans toutes les notes.
    id: 'plugin-mermaid', preinstalled: false, editorDefault: true,
    manifest: {
      id: 'plugin-mermaid',
      name: 'Mermaid Diagrams',
      version: '0.0.1',
      description: 'Rendu de diagrammes Mermaid dans l\'éditeur',
      scope: 'personal',
      permissions: ['ui:editor', 'vault:read', 'vault:write', 'agents'],
      defaultActive: true,
      trust: 'verified',
    },
    extensions: [],
    load: async () => (await import('@savoire/plugin-mermaid')).default,
  },
  // Communaute : le reste.
  {
    id: 'plugin-office', preinstalled: false,
    manifest: {
      id: 'plugin-office',
      trust: 'verified',
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
    // Modele d'agent (ADR-033) : la personne en fait un agent dans Parametres → Agents.
    id: 'plugin-agent-proofreader', preinstalled: false,
    manifest: {
      id: 'plugin-agent-proofreader',
      trust: 'verified',
      name: 'Agents Correcteur et Relecteur',
      version: '0.2.0',
      description: 'Des modèles d’agents qui corrigent une note, ou veillent sur elle pendant l’écriture',
      scope: 'personal',
      permissions: ['agents'],
    },
    extensions: [],
    load: async () => (await import('@savoire/plugin-agent-proofreader')).default,
  },
  {
    // Fournisseur d'IA apporte par un plugin : il decrit le service, l'application l'appelle.
    id: 'plugin-ai-mistral', preinstalled: false,
    manifest: {
      id: 'plugin-ai-mistral',
      trust: 'verified',
      name: 'Mistral AI',
      version: '0.0.1',
      description: 'Ajoute Mistral AI aux services d’IA (votre clé reste dans Savoire)',
      scope: 'personal',
      permissions: ['ai'],
    },
    extensions: [],
    load: async () => (await import('@savoire/plugin-ai-mistral')).default,
  },
  {
    id: 'plugin-chat', preinstalled: false,
    manifest: {
      id: 'plugin-chat',
      trust: 'verified',
      name: 'Discussions',
      version: '0.0.1',
      description: 'Des discussions en direct entre les membres du vault (fichiers .chat)',
      scope: 'vault',
      permissions: ['ui:editor', 'vault:read', 'agents'],
    },
    extensions: ['chat'],
    load: async () => (await import('@savoire/plugin-chat')).default,
  },
  {
    id: 'plugin-outline', preinstalled: false,
    manifest: {
      id: 'plugin-outline',
      trust: 'verified',
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
    // Installe par defaut : les pages sont le type par defaut de la vue
    // Notion (accueil, disposition). Il se desinstalle comme les autres.
    id: 'plugin-page', preinstalled: true,
    manifest: {
      id: 'plugin-page',
      trust: 'verified',
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
    // Ancien « QuickRef » : un vault qui l'avait installe garde le plugin.
    id: 'plugin-bible', preinstalled: false, formerIds: ['plugin-quickref'],
    manifest: {
      id: 'plugin-bible',
      name: 'Bible',
      version: '0.1.0',
      description: 'Choisir et télécharger sa Bible, puis citer : « ! » et un livre, un chapitre ou un mot insère les versets',
      scope: 'vault',
      permissions: ['ui:editor', 'vault:read', 'vault:write', 'network:wol.jw.org', 'agents'],
      defaultActive: true,
      trust: 'verified',
    },
    extensions: [],
    load: async () => (await import('@savoire/plugin-bible')).default,
  },
  {
    // Communaute, a installer : documents .tex ecrits a plusieurs (CRDT), avec apercu.
    id: 'plugin-latex', preinstalled: false,
    manifest: {
      id: 'plugin-latex',
      trust: 'verified',
      name: 'LaTeX',
      version: '0.0.1',
      description: 'Des documents LaTeX (.tex) écrits à plusieurs, avec un aperçu des formules',
      scope: 'vault',
      permissions: ['ui:editor', 'vault:read'],
      defaultActive: true,
    },
    extensions: ['tex'],
    load: async () => (await import('@savoire/plugin-latex')).default,
  },
]

// ── Paquets du Savoire Store ─────────────────────────────────────────────────
// Un paquet installe (savoireStore.ts) entre dans le catalogue comme les
// plugins livres avec Savoire : memes reglages (pour tout le vault ou pour
// soi), meme activation, meme API.

const packageEntries = new Map<string, StoreEntry>()
const catalogListeners = new Set<() => void>()

/** Ajoute ou remplace l'entree d'un paquet du store. */
export function setPackageEntry(entry: StoreEntry): void {
  packageEntries.set(entry.id, { ...entry, fromStore: true })
  for (const cb of catalogListeners) cb()
}

export function removePackageEntry(id: string): void {
  if (packageEntries.delete(id)) for (const cb of catalogListeners) cb()
}

/** Tout le catalogue : les plugins de Savoire, puis les paquets du store. */
export function catalogEntries(): StoreEntry[] {
  return [...STORE_CATALOG, ...[...packageEntries.values()].filter(e => !STORE_CATALOG.some(s => s.id === e.id))]
}

export function findCatalogEntry(id: string): StoreEntry | undefined {
  return STORE_CATALOG.find(e => e.id === id) ?? packageEntries.get(id)
}

export function onCatalogChange(cb: () => void): () => void {
  catalogListeners.add(cb)
  return () => { catalogListeners.delete(cb) }
}

/**
 * Les plugins d'un module (une note affichee seule : integree dans une autre
 * note, sur un site, dans un lien de partage). Seulement ceux du document :
 * les plugins d'edition (blocs des notes) et celui qui ouvre son type de
 * fichier. Pas l'environnement de travail (explorateur, recherche, panneaux).
 */
export function modulePluginEntries(path: string): StoreEntry[] {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return catalogEntries().filter(e => e.editorDefault || (e.extensions?.includes(ext) ?? false))
}

/** Charge les plugins d'un module (ceux qui ne demandent aucun contexte du poste de travail). */
export async function loadModulePlugins(path: string): Promise<{ editor: VaultPlugin[]; fileTypes: VaultPlugin[] }> {
  const noContext = { vaultBrowserRefs: null as never, setGraphContributor: () => {} } as PluginLoadContext
  const entries = modulePluginEntries(path)
  const loaded = await Promise.all(entries.map(async e => ({ e, plugin: await e.load(noContext).catch(() => null) })))
  const ok = loaded.filter((x): x is { e: StoreEntry; plugin: VaultPlugin } => !!x.plugin)
  return {
    editor: ok.filter(x => x.e.editorDefault).map(x => x.plugin),
    fileTypes: ok.filter(x => !x.e.editorDefault).map(x => x.plugin),
  }
}
