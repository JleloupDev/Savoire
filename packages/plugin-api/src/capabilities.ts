// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Les systemes de Savoire, et ce qu'un plugin en implemente.
//
// Savoire offre des systemes communs a tous les documents : recherche
// globale, liens et backlinks, index, collaboration temps reel, versions,
// revision (propositions), comparaison, IA locale, IA par MCP, modules
// integrables. Chaque systeme est une interface : un plugin l'implemente en
// enregistrant ce qu'il faut (un extracteur de texte, un type de proposition,
// un type de fichier CRDT...). Rien d'autre a declarer.
//
// L'application analyse ce que chaque plugin a enregistre a son chargement
// (analyzeCapabilities) : elle sait, sans le croire sur parole, avec quels
// systemes il fonctionne. Le manifeste peut aussi les annoncer (capabilities) ;
// le store les affiche, et l'application signale un plugin qui annonce plus
// qu'il ne fait.
//
// Trois niveaux :
//  - 'native'  : le plugin implemente l'interface du systeme ;
//  - 'generic' : le systeme marche quand meme, par le mecanisme commun (une
//                comparaison qui ouvre l'editeur deux fois, l'IA qui lit le
//                texte extrait...), sans le soin propre au plugin ;
//  - 'none'    : le systeme ne voit pas ce que le plugin apporte.
import type { FileTypeSpec, FileView } from './files'

export type CapabilityId =
  | 'search'
  | 'links'
  | 'index'
  | 'realtime'
  | 'versions'
  | 'revision'
  | 'compare'
  | 'ai-local'
  | 'ai-mcp'
  | 'modules'

export type CapabilityLevel = 'native' | 'generic' | 'none'

export interface CapabilityInfo {
  id: CapabilityId
  /** Nom affiche (« Recherche globale »). */
  label: string
  /** Ce que le systeme fait, en une phrase. */
  description: string
  /** Ce qu'un plugin enregistre pour l'implementer. */
  implementedBy: string
}

/** Les systemes de Savoire, dans l'ordre d'affichage. */
export const SAVOIRE_CAPABILITIES: readonly CapabilityInfo[] = [
  { id: 'search', label: 'Recherche globale', description: 'Le contenu de ses documents apparait dans la recherche du vault.', implementedBy: 'FileTypeSpec.contentExtractor, ou api.extractors.register' },
  { id: 'links', label: 'Liens et backlinks', description: 'Les liens de ses documents comptent dans les backlinks et le graphe.', implementedBy: 'Un index « links », ou des [[liens]] dans le texte extrait' },
  { id: 'index', label: 'Index et requêtes', description: 'Il publie ses propres entrées d’index, partagées entre membres et interrogeables.', implementedBy: 'api.index.registerFactory' },
  { id: 'realtime', label: 'Collaboration temps réel', description: 'Plusieurs membres éditent ses documents en même temps, sans conflit.', implementedBy: "FileTypeSpec.collaborationMode = 'crdt' (ctx.text ou ctx.tree)" },
  { id: 'versions', label: 'Versions', description: 'L’historique garde les versions de ses documents.', implementedBy: "Un document 'crdt', ou un type ouvert dans Savoire (instantanés)" },
  { id: 'revision', label: 'Révision', description: 'En mode suggestion, on propose des modifications au lieu d’écrire.', implementedBy: 'api.review.registerProposalType, ou FileTypeSpec.review' },
  { id: 'compare', label: 'Comparaison', description: 'Deux versions ou une proposition se comparent côte à côte, au rideau, en alternance.', implementedBy: 'FileTypeSpec.review.diff (éléments changés), sinon la vue en lecture seule' },
  { id: 'ai-local', label: 'IA locale', description: 'L’IA de la personne lit ses documents ; il peut proposer des agents ou un fournisseur.', implementedBy: 'Texte extrait ; api.agents.register ; api.ai.registerProvider' },
  { id: 'ai-mcp', label: 'IA par MCP', description: 'Les assistants externes (ChatGPT, Claude...) lisent ses documents par l’API ouverte.', implementedBy: 'Texte extrait (contentExtractor ou extracteur)' },
  { id: 'modules', label: 'Modules intégrables', description: 'Ses documents s’intègrent dans une note, une discussion, une page publiée.', implementedBy: 'FileTypeSpec.renderEmbed' },
]

export const capabilityInfo = (id: string): CapabilityInfo | undefined => SAVOIRE_CAPABILITIES.find(c => c.id === id)

export const isCapabilityId = (id: unknown): id is CapabilityId =>
  typeof id === 'string' && SAVOIRE_CAPABILITIES.some(c => c.id === id)

// ── Interfaces de la comparaison et de la revision ──────────────────────────

/** Un element qui change entre deux etats d'un document (forme, cellule, noeud...). */
export interface DiffItem {
  /** Identifiant stable de l'element dans le document. */
  id: string
  change: 'added' | 'removed' | 'modified' | 'moved'
  /** Ce que c'est, pour la liste des differences (« Rectangle », « Statut de Tâche 3 »). */
  label?: string
}

/**
 * Ce qu'un type de fichier apporte a la revision et a la comparaison. Tout
 * est facultatif : sans rien, la comparaison ouvre deux fois la vue en
 * lecture seule (niveau 'generic').
 */
export interface FileTypeReview {
  /** Type de proposition du plugin pour ce fichier (« excalidraw.scene »). */
  proposalType?: string
  /** Les elements qui changent d'un etat (contenu brut) a l'autre. */
  diff?(before: string, after: string): DiffItem[]
}

/**
 * Ce qu'une vue ouverte sait faire pendant une comparaison. Facultatif : une
 * vue qui ne l'implemente pas est montree telle quelle.
 */
export interface ComparableView {
  /** Colorie ces elements (ajoutes en vert, retires en rouge...). */
  highlight?(items: DiffItem[]): void
  /** Amene cet element a l'ecran (zoom, defilement). */
  focus?(item: DiffItem): void
  /** Zoom et defilement, pour synchroniser deux vues cote a cote. */
  getViewport?(): { x: number; y: number; zoom: number }
  setViewport?(v: { x: number; y: number; zoom: number }): void
  onViewportChange?(cb: (v: { x: number; y: number; zoom: number }) => void): () => void
}

export type ComparableFileView = FileView & ComparableView

// ── Ce qu'un plugin a enregistre, et l'analyse ──────────────────────────────

/** Ce qu'un plugin a enregistre pendant son chargement (releve par l'application). */
export interface PluginRegistrations {
  fileTypes: FileTypeSpec[]
  /** Extensions couvertes par ses extracteurs de texte. */
  extractors: string[]
  /** Namespaces de ses index. */
  indexes: string[]
  agents: number
  aiProviders: number
  proposalTypes: string[]
  views: number
  blocks: number
  commands: number
}

export const emptyRegistrations = (): PluginRegistrations => ({
  fileTypes: [], extractors: [], indexes: [], agents: 0, aiProviders: 0, proposalTypes: [], views: 0, blocks: 0, commands: 0,
})

export interface CapabilityReport {
  id: CapabilityId
  level: CapabilityLevel
  /** Pourquoi ce niveau, en clair. */
  via: string
}

/**
 * Avec quels systemes de Savoire fonctionne ce que le plugin a enregistre.
 * Un plugin sans document ni texte (une commande, un panneau) n'est concerne
 * par aucun : tout est 'none', ce n'est pas un defaut.
 */
export function analyzeCapabilities(r: PluginRegistrations): CapabilityReport[] {
  const types = r.fileTypes
  const withText = types.filter(t => !!t.contentExtractor).map(t => '.' + t.extension)
  const extracted = withText.length > 0 || r.extractors.length > 0
  const textVia = [...withText, ...r.extractors.map(e => '.' + e)].join(', ')
  const crdt = types.filter(t => t.collaborationMode === 'crdt').map(t => '.' + t.extension)
  const opened = types.filter(t => typeof t.open === 'function').map(t => '.' + t.extension)
  const diffs = types.filter(t => typeof t.review?.diff === 'function').map(t => '.' + t.extension)
  const proposals = [...r.proposalTypes, ...types.map(t => t.review?.proposalType).filter((p): p is string => !!p)]
  const embeds = types.filter(t => typeof t.renderEmbed === 'function').map(t => '.' + t.extension)
  const linkIndex = r.indexes.find(n => /link/i.test(n))

  const rep = (id: CapabilityId, level: CapabilityLevel, via: string): CapabilityReport => ({ id, level, via })
  return [
    extracted ? rep('search', 'native', `texte extrait : ${textVia}`) : rep('search', 'none', 'aucun texte extrait'),
    linkIndex ? rep('links', 'native', `index « ${linkIndex} »`)
      : extracted ? rep('links', 'generic', 'liens du texte extrait')
        : rep('links', 'none', 'aucun lien publié'),
    r.indexes.length ? rep('index', 'native', `index : ${r.indexes.join(', ')}`) : rep('index', 'none', 'aucun index'),
    crdt.length ? rep('realtime', 'native', `CRDT : ${crdt.join(', ')}`)
      : types.length ? rep('realtime', 'none', 'un seul rédacteur à la fois (verrou)')
        : rep('realtime', 'none', 'aucun type de document'),
    crdt.length ? rep('versions', 'native', `historique CRDT : ${crdt.join(', ')}`)
      : opened.length ? rep('versions', 'generic', `instantanés : ${opened.join(', ')}`)
        : rep('versions', 'none', 'aucun type de document'),
    proposals.length ? rep('revision', 'native', `propositions : ${[...new Set(proposals)].join(', ')}`)
      : opened.length ? rep('revision', 'generic', `brouillon comparé : ${opened.join(', ')}`)
        : rep('revision', 'none', 'aucun type de document'),
    diffs.length ? rep('compare', 'native', `différences par élément : ${diffs.join(', ')}`)
      : opened.length ? rep('compare', 'generic', `vue en lecture seule : ${opened.join(', ')}`)
        : rep('compare', 'none', 'aucun type de document'),
    r.agents || r.aiProviders
      ? rep('ai-local', 'native', [r.agents ? `${r.agents} agent(s)` : '', r.aiProviders ? `${r.aiProviders} fournisseur(s)` : ''].filter(Boolean).join(', '))
      : extracted ? rep('ai-local', 'generic', 'l’IA lit le texte extrait') : rep('ai-local', 'none', 'aucun texte lisible'),
    extracted ? rep('ai-mcp', 'generic', 'texte extrait, lu par l’API ouverte') : rep('ai-mcp', 'none', 'aucun texte lisible'),
    embeds.length ? rep('modules', 'native', `intégrable : ${embeds.join(', ')}`) : rep('modules', 'none', 'pas de rendu intégré'),
  ]
}

/** Les capacites annoncees par le manifeste et absentes de l'analyse. */
export function overclaimedCapabilities(declared: readonly string[] | undefined, report: readonly CapabilityReport[]): CapabilityId[] {
  if (!declared?.length) return []
  return declared.filter(isCapabilityId).filter(id => (report.find(r => r.id === id)?.level ?? 'none') === 'none')
}
