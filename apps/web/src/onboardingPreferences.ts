// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Accueil de la premiere visite (ce poste) : d'ou vient la personne
// (Obsidian, Notion, ni l'un ni l'autre) et le type de fichier cree par
// defaut. Le choix pose une vue par defaut de la disposition, puis tout reste
// modifiable dans les options. Une personne qui a deja regle sa disposition
// ne voit pas l'accueil.

import { hasLayoutPreferences, selectLayoutPreset, updateLayoutConfig } from './layoutPreferences'
import { setShowEditorToolbar, setShowFileExtensions } from './displayPreferences'

const KEY = 'savoire-onboarding'

export type OnboardingOrigin = 'obsidian' | 'notion' | 'other'

/** Vue par defaut posee pour chaque origine. */
const PRESET_OF: Record<OnboardingOrigin, string> = {
  obsidian: 'obsidian',
  notion: 'notion',
  other: 'savoire',
}

/** Type de fichier propose d'abord pour chaque origine. */
export const SUGGESTED_FILE_TYPE: Record<OnboardingOrigin, 'md' | 'page'> = {
  obsidian: 'md',
  notion: 'page',
  other: 'md',
}

/** Premiere visite sur ce poste : ni accueil fait, ni disposition reglee. */
export function needsOnboarding(): boolean {
  try { return localStorage.getItem(KEY) === null && !hasLayoutPreferences() } catch { return false }
}

/** L'accueil est fait (ou passe) : il ne revient plus. */
export function markOnboardingDone(): void {
  try { localStorage.setItem(KEY, 'done') } catch { /* navigation privee */ }
}

/**
 * Applique les reponses : la vue par defaut de l'origine (panneaux,
 * affichage) puis le type de fichier choisi.
 */
export function applyOnboarding(origin: OnboardingOrigin, fileType: string): void {
  const preset = selectLayoutPreset(PRESET_OF[origin])
  setShowEditorToolbar(preset.display.editorToolbar)
  setShowFileExtensions(preset.display.showFileExtensions)
  if (fileType !== preset.config.defaultFileType) updateLayoutConfig({ defaultFileType: fileType })
  markOnboardingDone()
}
