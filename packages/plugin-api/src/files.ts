// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// ─── File types ─────────────────────────────────────────────────────────
import type { VaultAPI } from './vault'
import type { ContentExtractor } from './indexing'
import type { DocumentSharedData } from './sharedMap'

export interface FileContext {
  vaultId: string
  path: string
  /** Id of the current user, used for sync (DocumentRoom). */
  userId?: string
  /** Nom affiche de la personne courante. */
  userName?: string
  /**
   * Donnees partagees de ce document : cartes CRDT synchronisees entre les
   * membres. Absent sans session de vault (document partage isole).
   */
  shared?: DocumentSharedData
  /** VaultAPI injected so the plugin can read/write without depending on an internal import. */
  vault?: VaultAPI
  /** Vue ouverte en lecture seule (ACL, ou verrou detenu par quelqu'un d'autre). */
  readOnly?: boolean
  /**
   * Called by the FileView when its content is stabilized (after internal debounce).
   * The app layer converts the raw content via contentExtractor.toShadowDocument()
   * and pushes it to ContentIndexingService for local index update
   */
  onContentStabilized?: (rawContent: string) => void
}

export interface FileView {
  mount(container: HTMLElement): void
  /**
   * Bascule la vue en lecture seule, ou l'en sort. Appele quand le verrou
   * d'edition change de main.
   *
   * L'alternative — remonter la vue — fait courir une course entre le
   * demontage de la racine React du plugin et le remontage : c'est exactement
   * ce qui produisait un « removeChild: node is not a child of this node ».
   * Une vue qui l'implemente n'est jamais remontee pour un simple changement
   * de verrou.
   */
  setReadOnly?(readOnly: boolean): void
  destroy(): void
}

/**
 * Comment ce type de document se comporte a plusieurs.
 *
 *  'crdt' — edition simultanee. Les modifications convergent, personne ne perd
 *           son travail. Reserve aux types dont l'etat EST un CRDT.
 *
 *  'lock' — un seul redacteur a la fois. Les autres voient le document en
 *           lecture seule et peuvent demander la main. C'est le mode a
 *           declarer des que la synchronisation se fait par snapshots en
 *           dernier-ecrivain-gagne : sans verrou, deux personnes qui editent
 *           en meme temps s'ecrasent mutuellement, en silence.
 *
 *  'none' — ni CRDT ni verrou. Pour un document qui n'est qu'un pointeur
 *           (lien vers un document en ligne) : il change rarement, la
 *           collaboration se fait ailleurs, et un verrou serait une gene
 *           plus qu'une protection. Le dernier qui ecrit gagne.
 *
 * Defaut : 'lock'. Un type qui ne se prononce pas n'est pas un CRDT, et
 * l'hypothese prudente est celle qui ne perd pas de donnees.
 */
export type CollaborationMode = 'crdt' | 'lock' | 'none'

export interface FileTypeSpec {
  extension: string
  label: string
  icon: string
  /** Voir CollaborationMode. Defaut : 'lock'. */
  collaborationMode?: CollaborationMode
  /**
   * If false, this type does not appear in the creation picker (e.g., images).
   * The icon is still used elsewhere (file tree, tabs, etc.).
   * Default: true.
   */
  creatable?: boolean
  create(): Promise<string>
  /**
   * Opens the file in a custom view. If absent, the host editor (EditorCore) handles
   * the file — use this for types like Markdown whose editor is built into the core.
   */
  open?(path: string, ctx: FileContext): FileView
  /** Read-only rendering for ![[file.ext]] embeds in a markdown note. */
  renderEmbed?(path: string, ctx: FileContext): Promise<HTMLElement>
  /**
   * Markdown content extractor for indexing.
   * If defined, the client calls toShadowDocument() after each save
   * and pushes the result to the server for indexing.
   */
  contentExtractor?: ContentExtractor
}

export interface FileTypeRegistry {
  register(spec: FileTypeSpec): void
  unregister(extension: string): void
  /** Returns the registered spec for this extension, or undefined if none. */
  resolve(extension: string): FileTypeSpec | undefined
  /** Returns all registered file types, sorted by extension. */
  getAll(): FileTypeSpec[]
}
