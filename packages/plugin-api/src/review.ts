// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Revision : propositions de modification, comme le suivi des modifications
// de Word, pour tous les types de documents.
//
// Une proposition ne change pas le document : elle attend, dans le panneau
// Revision, qu'un membre l'accepte (elle est alors appliquee) ou la refuse.
// Le texte des notes a son propre mode (frappe interceptee). Les autres types
// de documents passent par ici : le plugin du type
//  - declare son type de proposition (registerProposalType) : comment la
//    decrire, l'apercu, et comment l'appliquer ;
//  - en mode suggestion (suggesting), propose au lieu d'ecrire (propose).
//
// Exemples : une base propose une valeur de cellule, un dessin propose une
// nouvelle version de la scene, un document LaTeX propose une modification
// de son texte.

/** Un type de proposition, declare par le plugin qui sait l'appliquer. */
export interface ProposalTypeSpec {
  /** Identifiant unique, prefixe par le plugin : « base.cell », « excalidraw.scene ». */
  type: string
  /** Nom affiche du type (« Cellule de base », « Dessin »). */
  label: string
  /** Ce que la proposition change, en une phrase (« Statut : En cours → Fait »). */
  describe(payload: unknown): string
  /** Apercu dans le panneau Revision (facultatif). Peut rendre une fonction de nettoyage. */
  render?(payload: unknown, container: HTMLElement): void | (() => void)
  /**
   * Applique la proposition au document. Rejette si ce n'est plus possible
   * (le document a change depuis) : la proposition reste ouverte.
   */
  apply(docId: string, payload: unknown): Promise<void>
  /**
   * Comparaison (facultatif) : le document avant et apres la proposition, en
   * contenu brut que la vue du type sait afficher en lecture seule
   * (FileTypeSpec.open, sans arbre ni texte partage, contenu lu par
   * ctx.vault.readDocumentByPath). L'ecran « Comparer » les montre cote a
   * cote, au rideau, en alternance.
   */
  compare?(docId: string, payload: unknown): Promise<{ before: string; after: string }>
}

/** Une proposition, telle que le panneau la montre. */
export interface ProposalInfo {
  id: string
  docId: string
  type: string
  payload: unknown
  note: string
  authorName: string
  createdAt: string
  status: 'open' | 'accepted' | 'rejected'
}

export interface ReviewAPI {
  /** Declare un type de proposition. Rend la fonction qui le retire. */
  registerProposalType(spec: ProposalTypeSpec): () => void
  /**
   * Propose une modification d'un document (le payload doit etre du JSON,
   * 256 Kio au plus). Rend l'identifiant de la proposition.
   */
  propose(docId: string, type: string, payload: unknown, note?: string): Promise<string>
  /** Propositions d'un document (toutes, ou d'un type). */
  list(docId: string, type?: string): ProposalInfo[]
  /** Une proposition ou son statut a change. */
  onChange(cb: () => void): () => void
  /** Mode suggestion actif : les editeurs proposent au lieu d'ecrire. */
  readonly suggesting: boolean
  /**
   * Pour un editeur de texte CodeMirror d'un plugin (LaTeX, code...) : une
   * extension a installer. En mode suggestion, la frappe ne modifie plus le
   * document : elle devient des propositions de texte (« savoire.text »),
   * acceptees ou refusees dans la Revision. Rend une Extension CodeMirror
   * (type opaque ici : plugin-api ne depend pas de CodeMirror).
   */
  textSuggestions?(docId: string): unknown
  onSuggestingChange(cb: (suggesting: boolean) => void): () => void
}

/** Type de proposition des textes des plugins (voir textSuggestions). */
export const TEXT_PROPOSAL = 'savoire.text'

/** Proposition de texte : remplacer `before` (vers la position `at`) par `after`. */
export interface TextProposalPayload {
  at: number
  before: string
  after: string
  /** Un peu du texte autour, pour l'afficher et retrouver le passage. */
  context?: { left: string; right: string }
}

/** Taille maximale du payload d'une proposition (JSON). */
export const MAX_PROPOSAL_BYTES = 256 * 1024
