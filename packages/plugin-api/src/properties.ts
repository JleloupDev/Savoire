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
  | 'person'       // identifiant d'un membre (ou une liste, voir PropertyDef.multiple)
  | 'status'       // un choix, ses options rangees en a faire / en cours / termine
  | 'url'
  | 'email'
  | 'phone'
  | 'files'        // pieces jointes : liens [[fichier]] ou adresses web
  | 'relation'     // lignes d'une autre base : liens [[note]] (voir PropertyDef.relation)
  | 'id'           // numero unique, pose a la creation de la ligne (prefixe : PropertyDef.prefix)
  | 'created'      // date-heure de creation, posee a la creation de la ligne
  | 'modified'     // date-heure de la derniere modification par une base
  | 'createdBy'    // qui a cree la ligne (id d'un membre)
  | 'modifiedBy'   // qui l'a modifiee en dernier par une base
  | 'aliases'      // autres noms de la note : un lien [[alias]] y mene (comme Obsidian)
  | 'tags'         // tags de la note, comme les #tags du texte (sans le #)

/** Une valeur, telle que l'index la conserve. Les listes : multiselect, liens multiples. */
export type PropertyValue = string | number | boolean | null | string[]

export interface PropertyOption {
  value: string
  /** Une des couleurs de l'appli (gray, brown, orange, yellow, green, blue, purple, pink, red). */
  color?: string
  /** Statut : groupe de l'option. */
  group?: StatusGroup
}

/** Groupes d'un statut, dans cet ordre. */
export type StatusGroup = 'todo' | 'doing' | 'done'
export const STATUS_GROUPS: readonly { group: StatusGroup; label: string }[] = [
  { group: 'todo', label: 'À faire' },
  { group: 'doing', label: 'En cours' },
  { group: 'done', label: 'Terminé' },
]
/** Options d'un statut neuf. */
export const DEFAULT_STATUS_OPTIONS: readonly PropertyOption[] = [
  { value: 'Pas commencé', color: 'gray', group: 'todo' },
  { value: 'En cours', color: 'blue', group: 'doing' },
  { value: 'Terminé', color: 'green', group: 'done' },
]

/** Affichage d'un nombre. */
export type NumberFormat = 'number' | 'integer' | 'decimal' | 'percent' | 'euro' | 'dollar' | 'pound' | 'franc'
export const NUMBER_FORMATS: readonly { format: NumberFormat; label: string }[] = [
  { format: 'number', label: 'Nombre' },
  { format: 'integer', label: 'Entier' },
  { format: 'decimal', label: 'Deux décimales' },
  { format: 'percent', label: 'Pourcentage' },
  { format: 'euro', label: 'Euro' },
  { format: 'dollar', label: 'Dollar' },
  { format: 'pound', label: 'Livre' },
  { format: 'franc', label: 'Franc suisse' },
]

/** Un nombre ecrit selon son format (fr-FR). */
export function formatNumber(n: number, format: NumberFormat | undefined): string {
  const fr = (o: Intl.NumberFormatOptions) => n.toLocaleString('fr-FR', o)
  switch (format) {
    case 'integer': return fr({ maximumFractionDigits: 0 })
    case 'decimal': return fr({ minimumFractionDigits: 2, maximumFractionDigits: 2 })
    case 'percent': return `${fr({ maximumFractionDigits: 2 })} %`
    case 'euro': return fr({ style: 'currency', currency: 'EUR' })
    case 'dollar': return fr({ style: 'currency', currency: 'USD' })
    case 'pound': return fr({ style: 'currency', currency: 'GBP' })
    case 'franc': return fr({ style: 'currency', currency: 'CHF' })
    default: return fr({ maximumFractionDigits: 10 })
  }
}

export interface PropertyDef {
  /** Cle dans le frontmatter. */
  key: string
  /** Nom affiche ; la cle par defaut. */
  label?: string
  type: PropertyType
  /** Valeurs proposees (select, multiselect, status). */
  options?: PropertyOption[]
  /** Nombre : son affichage. */
  format?: NumberFormat
  /** Nombre : en chiffres, en barre ou en anneau (sur `max`, 100 par defaut). */
  display?: 'number' | 'bar' | 'ring'
  max?: number
  /** Personne : plusieurs membres. */
  multiple?: boolean
  /** Numero unique : son prefixe (« TACHE » donne TACHE-12). */
  prefix?: string
  /**
   * Relation : la base visee (id de son document .base) et, si la relation
   * va dans les deux sens, la propriete de ses lignes qui pointe en retour.
   */
  relation?: { base: string; back?: string }
}

/** Types dont la valeur est posee par l'appli, jamais saisie. */
export const AUTO_PROPERTY_TYPES: readonly PropertyType[] = ['id', 'created', 'modified', 'createdBy', 'modifiedBy']

/** Types dont la valeur est une liste. */
export function isListType(type: PropertyType, def?: Pick<PropertyDef, 'multiple'>): boolean {
  return type === 'multiselect' || type === 'aliases' || type === 'tags' || type === 'files' || type === 'relation' || (type === 'person' && !!def?.multiple)
}

/** Une date, ou une periode « debut/fin » (ISO 8601). */
export function splitDateRange(value: string): { start: string; end?: string } {
  const i = value.indexOf('/')
  if (i < 0) return { start: value }
  return { start: value.slice(0, i), end: value.slice(i + 1) || undefined }
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
  /**
   * Attend que les types soient lus. Sur le pair indexeur, ils ne le sont
   * qu'a la demande : un outil d'agent l'appelle avant schema, get ou set.
   * Absent : ils sont deja la.
   */
  ready?(): Promise<void>
}

export const PROPERTY_TYPES: readonly PropertyType[] = [
  'text', 'number', 'date', 'checkbox', 'select', 'multiselect', 'status', 'link', 'relation', 'person',
  'url', 'email', 'phone', 'files', 'id', 'created', 'modified', 'createdBy', 'modifiedBy', 'aliases', 'tags',
]

/**
 * Proprietes dont le nom fixe le type, comme dans Obsidian : `tags` et
 * `aliases` (et l'ancien `alias`) ont toujours le leur, sauf declaration contraire.
 */
export const RESERVED_PROPERTY_TYPES: Readonly<Record<string, PropertyType>> = {
  tags: 'tags', tag: 'tags', aliases: 'aliases', alias: 'aliases',
}

/** Libelle et icone de chaque type, les memes partout. */
export const PROPERTY_TYPE_INFO: Readonly<Record<PropertyType, { label: string; icon: string }>> = {
  text: { label: 'Texte', icon: 'text' },
  number: { label: 'Nombre', icon: 'hash' },
  date: { label: 'Date', icon: 'calendar' },
  checkbox: { label: 'Case à cocher', icon: 'square-check' },
  select: { label: 'Choix', icon: 'circle-dot' },
  multiselect: { label: 'Choix multiple', icon: 'list' },
  link: { label: 'Lien', icon: 'link' },
  person: { label: 'Personne', icon: 'user' },
  status: { label: 'Statut', icon: 'circle-dot-dashed' },
  url: { label: 'Adresse web', icon: 'globe' },
  email: { label: 'E-mail', icon: 'at-sign' },
  phone: { label: 'Téléphone', icon: 'phone' },
  files: { label: 'Fichiers', icon: 'paperclip' },
  relation: { label: 'Relation', icon: 'arrow-up-right' },
  id: { label: 'Numéro unique', icon: 'fingerprint' },
  created: { label: 'Créé le', icon: 'calendar-plus' },
  modified: { label: 'Modifié le', icon: 'calendar-clock' },
  createdBy: { label: 'Créé par', icon: 'user-plus' },
  modifiedBy: { label: 'Modifié par', icon: 'user-pen' },
  aliases: { label: 'Alias', icon: 'forward' },
  tags: { label: 'Tags', icon: 'tags' },
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?(\/\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?)?$/
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
    case 'files':
    case 'relation':
    case 'aliases':
      if (Array.isArray(value)) return value
      return value === '' ? [] : [String(value)]
    case 'tags': {
      // « a, b » ou « #a #b » sur une ligne, ou une liste : des tags sans #.
      const list = Array.isArray(value) ? value : String(value).split(/[\s,]+/)
      return list.map(t => String(t).trim().replace(/^#/, '')).filter(Boolean)
    }
    case 'person':
      // Une liste de membres reste une liste (PropertyDef.multiple).
      if (Array.isArray(value)) return value
      if (typeof value === 'number' || typeof value === 'boolean') return String(value)
      return value
    case 'id':
      if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value)
      return typeof value === 'boolean' ? String(value) : value
    case 'text':
    case 'select':
    case 'status':
    case 'date':
    case 'link':
    case 'url':
    case 'email':
    case 'phone':
    case 'created':
    case 'modified':
    case 'createdBy':
    case 'modifiedBy':
      if (typeof value === 'number' || typeof value === 'boolean') return String(value)
      return value
  }
}

/** Type effectif d'une propriete : declare, sinon devine depuis la valeur. */
export function propertyTypeOf(types: Pick<IPropertyTypes, 'get'> | undefined, key: string, value?: PropertyValue): PropertyType {
  return types?.get(key)?.type ?? RESERVED_PROPERTY_TYPES[key.toLowerCase()] ?? guessPropertyType(value)
}

// Lecture et edition du frontmatter (une seule implementation, dans
// domain-index), offertes aux plugins qui ne dependent que de plugin-api.
export {
  parseFrontmatter, findFrontmatter, setFrontmatterValue, removeFrontmatterKey,
  renameFrontmatterKey, frontmatterKeys, minimalTextChange,
} from '@savoire/domain-index'
