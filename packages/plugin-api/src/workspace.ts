// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// ─── Workspace API ─────────────────────────────────────────────────────────

export interface ViewDocument {
  path: string
  content: string
}

export interface WorkspacePaneState {
  collapsed: boolean
}

/** Ou aller dans le document ouvert : la suite d'un lien (« Titre », « ^bloc », « page=3 »). */
export interface OpenFileOptions {
  subpath?: string
}

/**
 * Ce que la personne regarde dans une vue de document qui n'est pas une note
 * (un passage d'un PDF) : l'IA le lit par get_context, comme la selection
 * d'une note. `pdf` : ou, dans le PDF.
 */
export interface DocumentContextReport {
  vaultId: string
  docId: string
  path: string
  /** Le texte selectionne ('' : rien, seulement une page). */
  selection: string
  /** Un peu du texte juste avant et juste apres. */
  before: string
  after: string
  pdf?: {
    page: number
    pages: number
    rects: import('./pdf').PdfRect[]
    /** Un surlignage ou une ancre de la Revision, s'il s'agit de l'un d'eux. */
    ref?: string
    mark?: 'highlight' | 'anchor'
    color?: string
    label?: string
    /** Le commentaire du fil, s'il y en a un. */
    comment?: string
    /** Texte reconnu par l'OCR (page scannee). */
    ocr?: boolean
  }
}

export interface WorkspaceAPI {
  /** Ouvre un fichier ; `subpath` : y aller (vue qui sait le faire, voir subscribeReveal). */
  openFile(path: string, options?: OpenFileOptions): Promise<void>
  /**
   * La suite de lien en attente pour ce fichier (posee par openFile), une
   * seule fois : la vue la lit en s'ouvrant.
   */
  takeReveal?(path: string): string | undefined
  /** openFile avec une suite de lien, sur un fichier peut-etre deja ouvert : la vue y va. */
  subscribeReveal?(cb: (path: string, subpath: string) => void): () => void
  /** Une vue de document dit ce que la personne y regarde (null : plus rien). Voir DocumentContextReport. */
  reportContext?(report: DocumentContextReport | null): void
  openPanel(panelId: string): void
  closePanel(panelId: string): void
  collapsePane?(location: 'left' | 'right'): void
  expandPane?(location: 'left' | 'right'): void
  togglePane?(location: 'left' | 'right'): void
  getPaneState?(location: 'left' | 'right'): WorkspacePaneState
  subscribePaneState?(location: 'left' | 'right', cb: (state: WorkspacePaneState) => void): () => void
  getActiveDocument(): ViewDocument | undefined
  /** Subscribe to vault-change events (fired when selected vault changes). */
  subscribeVaultChange?(cb: () => void): () => void
  /** Notify all vault-change subscribers. */
  notifyVaultChange?(): void
  /** Subscribe to file-open events (fired when the user opens a document). */
  subscribeOpenFile?(cb: (path: string) => void): () => void
  /** Subscribe to active-document changes (fired on tab switch AND file open). */
  subscribeActiveDocument?(cb: (path: string) => void): () => void
  /** Subscribe to document-indexed events (fired after metadata extraction completes). */
  subscribeDocumentIndexed?(cb: (docId: string, path: string) => void): () => void
  /** Afficher l'extension des fichiers (preference de la personne) ? Absent : non. */
  showFileExtensions?(): boolean
  /** Delai avant l'apercu d'un lien survole, en ms (preference de la personne). 0 : pas d'apercu. Absent : 800. */
  linkPreviewDelay?(): number
  /**
   * Extension du type de fichier cree par defaut (preference de la personne,
   * donnee par la disposition) : « md » (note Markdown) ou « page »... Absent : « md ».
   */
  defaultFileType?(): string
  /** Une preference d'affichage a change (extension des fichiers, type par defaut...). */
  subscribeDisplayPreferences?(cb: () => void): () => void
  /** Affiche une notification breve (« 3 versets ajoutes »). Absent : rien ne s'affiche. */
  notify?(type: NotificationType, title: string, message?: string): void
  /** Ouvre les options de partage d'un module (lecture seule sur le web, ou ecriture). */
  shareModule?(path: string): void
}

export type NotificationType = 'success' | 'info' | 'warn' | 'danger'
