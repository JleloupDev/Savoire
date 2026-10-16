// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// ─── Commands ──────────────────────────────────────────────────────────────
//
// Une commande est une action nommee : l'application et les plugins en
// enregistrent, et le moteur de raccourcis les declenche au clavier. Meme
// principe que dans Obsidian : la commande declare ses raccourcis par defaut,
// la personne peut les remplacer, et tout plugin peut lire ou changer ces
// associations (HotkeyAPI).

export interface PluginCommandContext {
  /** Raw editor view — typed as unknown to avoid direct CM6 dependency in plugin-api.
   *  null quand aucun editeur n'a le focus (raccourci global). */
  editorView: unknown
}

/**
 * 'Mod' = Cmd sur Mac, Ctrl ailleurs : c'est ce qu'il faut utiliser dans un
 * raccourci par defaut. 'Ctrl' et 'Meta' visent une touche precise.
 */
export type HotkeyModifier = 'Mod' | 'Ctrl' | 'Meta' | 'Shift' | 'Alt'

/**
 * Un raccourci. `key` est une lettre, un chiffre ou un nom de touche
 * (`'b'`, `'7'`, `'Enter'`, `'ArrowUp'`), sans tenir compte de la casse.
 * Lettres et chiffres sont reconnus quelle que soit la disposition du clavier
 * (AZERTY : Ctrl+Maj+7 marche, meme si 7 demande Maj).
 */
export interface Hotkey {
  modifiers: HotkeyModifier[]
  key: string
}

export interface PluginCommand {
  id: string
  label?: string
  /** Raccourcis par defaut. La personne peut les remplacer (HotkeyAPI.setCustom). */
  hotkeys?: Hotkey[]
  /** Agit dans un editeur : ignoree tant qu'aucun editeur n'a le focus. */
  editor?: boolean
  /** Faux = la commande ne s'applique pas ici : la touche suit son cours normal. */
  isAvailable?(context: PluginCommandContext): boolean
  run(context: PluginCommandContext): void
}

export interface CommandRegistry {
  register(command: PluginCommand): void
  unregister(id: string): void
}

// ─── Hotkeys ───────────────────────────────────────────────────────────────

/** Ce qu'un plugin voit du moteur de raccourcis. */
export interface HotkeyAPI {
  /** Raccourcis en vigueur : personnalises s'il y en a, sinon ceux par defaut. */
  get(commandId: string): Hotkey[]
  /** Raccourcis par defaut, declares par la commande. */
  getDefault(commandId: string): Hotkey[]
  /** Remplace les raccourcis d'une commande. null = revenir au defaut, [] = aucun. */
  setCustom(commandId: string, hotkeys: Hotkey[] | null): void
  /** Toutes les personnalisations, par id de commande. */
  getCustom(): Record<string, Hotkey[]>
  /** Commandes actives qui repondent deja a ce raccourci. */
  findConflicts(hotkey: Hotkey): string[]
  /** Texte a afficher : « Ctrl+Maj+H », ou « ⇧⌘H » sur Mac. */
  format(hotkey: Hotkey): string
  /**
   * Raccourci correspondant a une touche pressee, pour en enregistrer un.
   * null pour une touche de modification seule (Ctrl, Maj...) ou une touche
   * qui sert a ecrire (sans Ctrl, Alt ni Cmd).
   */
  fromEvent(event: HotkeyEvent): Hotkey | null
  /** Une association a change (personnalisation, chargement). */
  onChange(cb: () => void): () => void
}

/** Evenement clavier, au sens minimal : un KeyboardEvent du DOM convient. */
export interface HotkeyEvent {
  key: string
  code: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
  defaultPrevented?: boolean
  preventDefault(): void
  getModifierState?(key: string): boolean
}

/** Cote hote : l'application et l'editeur branchent le clavier ici. */
export interface HotkeyHost extends HotkeyAPI {
  /**
   * Execute la commande liee a cette touche. Vrai si une commande l'a prise :
   * l'evenement est alors annule (preventDefault).
   */
  handleKeyEvent(event: HotkeyEvent, context: PluginCommandContext): boolean
  /** Charge des personnalisations sauvegardees (remplace les precedentes). */
  loadCustom(custom: Record<string, Hotkey[]>): void
}
