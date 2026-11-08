// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// ─── Editor position API ──────────────────────────────────────────────────

export interface EditorPositionAPI {
  getCursorCoords(): { x: number; y: number } | null
  getSelectionCoords(): { x: number; y: number } | null
  getSelectionText(): string
}

// ─── Toolbar commands ─────────────────────────────────────────────────────

export interface EditorCommandContext {
  // opaque — passed from EditorCore to command handlers
  // plugins receive this but treat it as a black box
  /** Editeur d'ou vient le clic, quand l'hote le connait. */
  view?: unknown
}

export interface ToolbarCommand {
  id: string
  label: string
  /** Nom d'une icone Lucide (« bold », « table », lucide.dev/icons). Un
   *  texte court (emoji, « H1 ») reste accepte et s'affiche tel quel. */
  icon: string
  group?: string              // 'format' | 'insert' | 'action'
  /** Range la commande dans un menu de la barre au lieu d'un bouton :
   *  « Insérer » (tableau, diagramme...) ou « ⋯ » (export, reglages). */
  menu?: 'insert' | 'more'
  /** Aussi dans la bulle qui apparait sur une selection. A reserver a ce
   *  qui s'applique a un bout de texte (gras, lien, commentaire...). */
  bubble?: boolean
  /** Bouton a menu : texte affiche a la place de l'icone, selon la position
   *  du curseur (« Titre 1 », « Texte »). */
  currentLabel?(ctx: EditorCommandContext): string | null
  /** Sous-commande : couleur montree en pastille (menu en palette). */
  swatch?: string
  /** Sous-commandes en grille de pastilles plutot qu'en liste. */
  itemsLayout?: 'list' | 'palette'
  requiresSelection?: boolean
  hotkeys?: Array<{ modifiers: string[]; key: string }>
  /** Commande (registre des commandes) que ce bouton declenche aussi au
   *  clavier : son raccourci s'affiche dans l'infobulle. */
  commandId?: string
  /** Sous-commandes affichees dans un menu deroulant. Quand il est present,
   *  `run` sert de defaut (clic sur le bouton lui-meme). Permet a un plugin
   *  d'offrir un menu sans que la barre ne s'allonge indefiniment. */
  items?: ToolbarCommand[]
  run(ctx: EditorCommandContext): void
  isActive?(ctx: EditorCommandContext): boolean
  isEnabled?(ctx: EditorCommandContext): boolean
}

export interface ToolbarCommandRegistry {
  register(cmd: ToolbarCommand): void
  unregister(id: string): void
  getAll(): ToolbarCommand[]
  getByGroup(group: string): ToolbarCommand[]
}
