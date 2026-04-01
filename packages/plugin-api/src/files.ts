// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// ─── File types ─────────────────────────────────────────────────────────
import type { VaultAPI } from './vault'
import type { ContentExtractor } from './indexing'

export interface FileContext {
  vaultId: string
  path: string
  /** Identifiant de l'utilisateur courant — utilisé pour la sync (DocumentRoom). */
  userId?: string
  /** VaultAPI injecté pour que le plugin puisse lire/écrire sans dépendre d'un import interne. */
  vault?: VaultAPI
  /**
   * Appelé par le FileView quand son contenu est stable (après debounce interne).
   * L'app layer convertit le contenu brut via contentExtractor.toShadowDocument()
   * et l'injecte dans ContentIndexingService pour la mise à jour de l'index local.
   */
  onContentStabilized?: (rawContent: string) => void
}

export interface FileView {
  mount(container: HTMLElement): void
  destroy(): void
}

export interface FileTypeSpec {
  extension: string
  label: string
  icon: string
  create(): Promise<string>
  open(path: string, ctx: FileContext): FileView
  /** Rendu read-only pour les embeds ![[file.ext]] dans une note markdown. */
  renderEmbed?(path: string, ctx: FileContext): Promise<HTMLElement>
  /**
   * Extracteur de contenu Markdown pour l'indexation.
   * Si défini, le client appelle toShadowDocument() après chaque sauvegarde
   * et pousse le résultat au serveur pour indexation.
   */
  contentExtractor?: ContentExtractor
}

export interface FileTypeRegistry {
  register(spec: FileTypeSpec): void
  unregister(extension: string): void
  /** Retourne le spec enregistré pour cette extension, ou undefined si aucun. */
  resolve(extension: string): FileTypeSpec | undefined
}
