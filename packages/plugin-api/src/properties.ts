// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// ─── Proprietes typees ────────────────────────────────────────────────────
//
// Les proprietes d'une note vivent dans son frontmatter (lisible par
// Obsidian). Leur TYPE n'est pas ecrit dans chaque note : il est declare par
// un schema (celui d'une base, ou du vault), comme dans Notion et Obsidian.
// Voir ADR-027.

export type PropertyType =
  | 'text'
  | 'number'
  | 'date'         // 'YYYY-MM-DD' ou date-heure ISO 8601
  | 'checkbox'
  | 'select'
  | 'multiselect'
  | 'link'         // lien vers une note : chemin ou [[cible]]
  | 'person'       // identifiant d'un membre

/** Une valeur, telle que l'index la conserve. Les listes : multiselect, liens multiples. */
export type PropertyValue = string | number | boolean | null | string[]

export interface PropertyOption {
  value: string
  /** Une des couleurs de l'appli (red, orange, yellow, green, blue, purple). */
  color?: string
}

export interface PropertyDef {
  /** Cle dans le frontmatter. */
  key: string
  /** Nom affiche ; la cle par defaut. */
  label?: string
  type: PropertyType
  /** Valeurs proposees (select, multiselect). */
  options?: PropertyOption[]
}

export interface PropertySchema {
  properties: PropertyDef[]
}
