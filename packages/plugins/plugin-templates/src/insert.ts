// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Inserer un modele dans une note, comme le plugin « Modèles » d'Obsidian :
// le corps du modele va au curseur ; ses proprietes (frontmatter) rejoignent
// celles de la note, sans ecraser une propriete deja la. Fonctions pures.
import { findFrontmatter, parseFrontmatter, setFrontmatterValue, type PropertyValue } from '@savoire/plugin-api'

export interface SplitTemplate {
  /** Les proprietes du modele, dans son ordre. */
  properties: [string, PropertyValue][]
  /** Le texte sans le bloc de proprietes. */
  body: string
}

/** Separe les proprietes d'un modele (deja rendu) de son corps. */
export function splitTemplate(text: string): SplitTemplate {
  const fm = findFrontmatter(text)
  if (!fm) return { properties: [], body: text }
  return { properties: Object.entries(parseFrontmatter(text)), body: text.slice(fm.end) }
}

/** Ajoute a la note les proprietes du modele qu'elle n'a pas encore. */
export function mergeTemplateProperties(note: string, properties: readonly [string, PropertyValue][]): string {
  if (!properties.length) return note
  const existing = parseFrontmatter(note)
  let out = note
  for (const [key, value] of properties) {
    if (key in existing) continue
    out = setFrontmatterValue(out, key, value ?? '')
  }
  return out
}

/**
 * La note apres insertion du modele au curseur `at`. Rend le texte et la
 * place du curseur (fin du corps insere).
 */
export function insertTemplate(note: string, at: number, rendered: string): { text: string; cursor: number } {
  const { properties, body } = splitTemplate(rendered)
  const before = note.slice(0, at)
  const after = note.slice(at)
  const inserted = before + body + after
  const merged = mergeTemplateProperties(inserted, properties)
  // Le bloc de proprietes a pu grandir avant le curseur : on decale d'autant.
  const shift = merged.length - inserted.length
  return { text: merged, cursor: at + body.length + Math.max(0, shift) }
}
