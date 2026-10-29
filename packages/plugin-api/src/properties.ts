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

// ── Types des proprietes du vault ──────────────────────────────────────────
//
// Comme `.obsidian/types.json` : le type d'une propriete vaut pour tout le
// vault et se partage entre les membres. Il sert aux editeurs (panneau de
// proprietes, cellules d'une base) ET aux requetes (une valeur est typee
// avant d'etre comparee). Une propriete sans type declare prend un type
// devine depuis sa valeur (guessPropertyType).

/** Un membre du vault, pour le type 'person'. */
export interface PropertyMember {
  id: string
  name: string
}

export interface IPropertyTypes {
  /** Toutes les proprietes dont le type est declare. */
  schema(): PropertySchema
  /** Definition declaree d'une propriete, ou undefined. */
  get(key: string): PropertyDef | undefined
  /** Declare (ou change) le type d'une propriete, pour tout le vault. */
  set(def: PropertyDef): void
  /** Oublie la declaration : le type redevient devine. */
  remove(key: string): void
  /** Un membre a change un type (localement ou a distance). */
  onChange(cb: () => void): () => void
  /** Membres du vault, si le profil de synchro les connait. */
  members?(): Promise<PropertyMember[]>
}

export const PROPERTY_TYPES: readonly PropertyType[] = [
  'text', 'number', 'date', 'checkbox', 'select', 'multiselect', 'link', 'person',
]

/** Libelle et icone de chaque type, les memes partout. */
export const PROPERTY_TYPE_INFO: Readonly<Record<PropertyType, { label: string; icon: string }>> = {
  text: { label: 'Texte', icon: '≡' },
  number: { label: 'Nombre', icon: '#' },
  date: { label: 'Date', icon: '📅' },
  checkbox: { label: 'Case à cocher', icon: '☑' },
  select: { label: 'Choix', icon: '◉' },
  multiselect: { label: 'Choix multiple', icon: '☰' },
  link: { label: 'Lien', icon: '🔗' },
  person: { label: 'Personne', icon: '👤' },
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/
const LINK_RE = /^\[\[[^\]]+\]\]$/

/** Type devine depuis une valeur, quand aucun n'est declare. */
export function guessPropertyType(value: PropertyValue | undefined): PropertyType {
  if (Array.isArray(value)) return 'multiselect'
  if (typeof value === 'boolean') return 'checkbox'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'string') {
    if (DATE_RE.test(value)) return 'date'
    if (LINK_RE.test(value)) return 'link'
  }
  return 'text'
}

/**
 * Une valeur lue (frontmatter, index), ramenee a son type quand c'est sans
 * perte : '3' devient 3 pour un nombre, 'a' devient ['a'] pour un choix
 * multiple. Une valeur qui ne se convertit pas reste telle quelle (le
 * panneau la signale, les requetes la comparent en texte).
 */
export function coercePropertyValue(value: PropertyValue | undefined, type: PropertyType): PropertyValue {
  if (value === undefined || value === null) return null
  switch (type) {
    case 'number': {
      if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
      return value
    }
    case 'checkbox': {
      if (typeof value === 'string' && /^(true|false)$/i.test(value.trim())) return value.trim().toLowerCase() === 'true'
      return value
    }
    case 'multiselect':
      if (Array.isArray(value)) return value
      return value === '' ? [] : [String(value)]
    case 'text':
    case 'select':
    case 'date':
    case 'link':
    case 'person':
      if (typeof value === 'number' || typeof value === 'boolean') return String(value)
      return value
  }
}

/** Type effectif d'une propriete : declare, sinon devine depuis la valeur. */
export function propertyTypeOf(types: Pick<IPropertyTypes, 'get'> | undefined, key: string, value?: PropertyValue): PropertyType {
  return types?.get(key)?.type ?? guessPropertyType(value)
}

// Lecture et edition du frontmatter (une seule implementation, dans
// domain-index), offertes aux plugins qui ne dependent que de plugin-api.
export {
  parseFrontmatter, findFrontmatter, setFrontmatterValue, removeFrontmatterKey,
  renameFrontmatterKey, frontmatterKeys, minimalTextChange,
} from '@savoire/domain-index'
