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

// Annotations dans le document : la personne peut travailler la revision sans
// quitter ce qu'elle lit. Les commentaires, suggestions et propositions se
// montrent par-dessus le document, a cote de ce qu'ils visent, et s'y
// traitent (repondre, accepter, refuser, resoudre). C'est un choix de la
// personne (inline, onInlineChange) ; le panneau Revision reste la vue
// d'ensemble. Tout editeur peut l'offrir :
//  - lister les annotations de son document (annotations) et les placer ou
//    il veut : `quote` pour un texte, `target` (choisi par le plugin a la
//    creation du commentaire, ou le payload d'une proposition) pour le reste ;
//  - y dessiner la carte standard de la revision (renderAnnotation), ou sa
//    propre interface avec reply / accept / reject / resolve ;
//  - un editeur de texte CodeMirror n'a qu'une extension a poser
//    (inlineAnnotations) : passages surlignes, texte propose, cartes au clic.

/** Une reponse dans un fil. */
export interface ReviewReply {
  id: string
  text: string
  authorName: string
  /** Ecrite par un agent (IA) au nom d'un membre. */
  byAgent: boolean
  createdAt: string
}

/**
 * Une annotation : un fil de la revision sur un document. 'comment' : un
 * commentaire ; 'suggestion' : une modification proposee du texte d'une
 * note ; 'proposal' : une proposition d'un plugin (voir ProposalTypeSpec).
 */
export interface ReviewAnnotation {
  id: string
  docId: string
  kind: 'comment' | 'suggestion' | 'proposal'
  /** Le commentaire, ou l'explication d'une proposition ('' : aucune). */
  text: string
  authorName: string
  byAgent: boolean
  createdAt: string
  status: 'open' | 'resolved' | 'rejected' | 'accepted'
  /** Passage vise (texte d'une note). */
  quote?: string
  /** Suggestion : le texte qui remplacerait le passage ('' : le supprimer). */
  replacement?: string
  /** Proposition : son type et son contenu. */
  proposalType?: string
  payload?: unknown
  /** Ce que vise un commentaire, choisi par le plugin (comment) : JSON. */
  target?: unknown
  replies: ReviewReply[]
}

/** Commentaire sur un passage d'un texte de plugin (cible lue par inlineAnnotations). */
export interface TextCommentTarget {
  /** Position du passage quand on l'a commente. */
  at: number
  /** Le passage ; retrouve le plus pres de `at`. */
  quote: string
}

/** Options de la carte standard (renderAnnotation). */
export interface AnnotationCardOptions {
  /** Appele quand le fil est traite (accepte, refuse, resolu) : fermer la carte. */
  onDone?(): void
}

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

  // ── Annotations dans le document (voir plus haut) ──

  /** La personne veut voir et traiter la revision dans le document. */
  readonly inline: boolean
  onInlineChange(cb: (inline: boolean) => void): () => void
  /** Fils d'un document : commentaires, suggestions, propositions, avec leurs reponses. */
  annotations(docId: string): ReviewAnnotation[]
  /**
   * Commente le document. `target` : ce que vise le commentaire, en JSON
   * (une cellule, une forme, TextCommentTarget pour un texte) ; absent : le
   * document entier. Rend l'identifiant du fil.
   */
  comment(docId: string, text: string, target?: unknown): Promise<string>
  /** Repond dans un fil. */
  reply(id: string, text: string): Promise<void>
  /** Accepte une suggestion ou une proposition : le document change. Rejette si le passage a change. */
  accept(id: string): Promise<void>
  /** Refuse une suggestion ou une proposition. */
  reject(id: string): Promise<void>
  /** Resout un commentaire (false : le rouvre). */
  resolve(id: string, resolved?: boolean): Promise<void>
  /**
   * Dessine la carte standard d'un ou plusieurs fils dans `container` (elle
   * suit les changements). Rend la fonction qui la retire.
   */
  renderAnnotation?(ids: string[], container: HTMLElement, options?: AnnotationCardOptions): () => void
  /**
   * Pour un editeur de texte CodeMirror d'un plugin : une extension a
   * installer. Quand la personne le veut (inline), les propositions de texte
   * (« savoire.text ») et les commentaires TextCommentTarget s'affichent dans
   * le texte et s'ouvrent d'un clic dans la carte standard. Type opaque, comme
   * textSuggestions.
   */
  inlineAnnotations?(docId: string): unknown
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
