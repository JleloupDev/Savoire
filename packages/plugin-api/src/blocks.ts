// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// ─── Blocks ────────────────────────────────────────────────────────────────

export interface BlockWidget {
  mount(container: HTMLElement): void
  destroy(): void
}

export interface BlockContext {
  editorView: unknown
  /** Remplace un passage du document (cocher une case, par exemple), sans
   *  passer par l'editeur. Absent ou sans effet en lecture seule. */
  edit?(from: number, to: number, insert: string): void
  /** Ligne du document qui porte ce rendu (pour la reecrire avec edit). Null si introuvable. */
  locate?(el: HTMLElement): { from: number; to: number; text: string } | null
}

/** Describes an entry in the slash command palette for this block type. */
export interface BlockTrigger {
  id: string
  label: string
  description?: string
  icon?: string
  category?: string
  insert: string | ((ctx: { query: string }) => string)
}

/**
 * Une ligne d'un bloc rendu ligne par ligne (voir BlockSpec.renderLine).
 * Le texte est la ligne brute, indentation et marqueur compris.
 */
export interface BlockLine {
  text: string
  /** Profondeur d'imbrication : 0 pour un element de premier niveau. */
  depth: number
  /** Debut de la ligne dans le document : pour la modifier (case a cocher). */
  from: number
}

export interface BlockSpec {
  type: string
  detect?: RegExp | ((text: string) => boolean)
  serialize(data: unknown): string
  deserialize(raw: string): unknown
  createEditorWidget(data: unknown, ctx: BlockContext): BlockWidget
  renderClient(data: unknown, ctx: BlockContext): HTMLElement
  /**
   * Rendu LIGNE PAR LIGNE, comme dans Obsidian. Quand il est fourni, chaque
   * ligne du bloc est rendue a part et seule la ligne du curseur passe en
   * edition (listes, citations). Sinon le bloc entier passe en edition des
   * qu'on y entre (code, callout, diagramme). Rend null pour laisser une ligne
   * telle quelle.
   */
  renderLine?(line: BlockLine, ctx: BlockContext): HTMLElement | null
  /** If defined, auto-registers slash command entries for this block. */
  trigger?: BlockTrigger | BlockTrigger[]
}

export interface BlockRegistry {
  register(spec: BlockSpec): void
  unregister(type: string): void
  detectBlock(text: string): { type: string; spec: BlockSpec } | null
  getAll(): BlockSpec[]
  /**
   * Returns only specs whose registering plugin is in `ids`, plus untagged built-ins.
   * null = no filtering (return all). Used by LivePreview to limit rendering per note scope.
   */
  getActive?(ids: Set<string> | null): BlockSpec[]
  /**
   * Like detectBlock but filtered by active scope ids.
   * null = no filtering (same as detectBlock). Used by LivePreview.
   */
  detectActive?(text: string, ids: Set<string> | null): { type: string; spec: BlockSpec } | null
}
