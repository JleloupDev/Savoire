// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Extraction d'une note pour l'index : { id, path, content } -> NoteRecord.
// Fonction pure, la meme partout (pair indexeur, bureau, navigateur).
//
// Regles :
//  - proprietes : le frontmatter, lu par l'analyseur commun (domain-index),
//    puis ramenees aux types declares (PropertySchema), s'il y en a ;
//  - titre : `title` du frontmatter, sinon premier titre de niveau 1 (comme
//    MetadataIndexContributor), sinon le nom du fichier sans extension (une
//    ligne de resultat a toujours un titre lisible) ;
//  - tags : `tags` / `tag` du frontmatter, puis les #tags du texte (hors code),
//    sans '#', sans doublon (casse ignoree) ;
//  - alias : `aliases` / `alias` du frontmatter ;
//  - texte brut : sans Markdown ni frontmatter, decoupe en sections.
import { findFrontmatter, parseFrontmatterYaml } from '@savoire/domain-index'
import { coercePropertyValue } from '@savoire/plugin-api'
import type { PropertySchema, PropertyValue } from '@savoire/plugin-api'
import { extOf, folderOf, stemOf } from '../paths'
import { parseMarkdownBody } from './markdown'
import type { LinkRef, Section } from './markdown'

export interface NoteInput {
  id: string
  path: string
  /** Markdown de la note, ou Markdown derive d'un autre type (voir crdt/content). */
  content: string
  /** Le contenu commence-t-il par un frontmatter ? Par defaut : oui pour un .md. */
  frontmatter?: boolean
  /** Dates ISO 8601, si l'hote les connait. */
  created?: string
  modified?: string
}

export type TitleSource = 'frontmatter' | 'heading' | 'name' | 'given'

/** Une note telle que l'index l'enregistre. */
export interface NoteRecord {
  id: string
  /** Chemin dans le vault ; vide pour une ligne legere de base. */
  path: string
  folder: string
  ext: string
  /** Ligne legere : id du document de sa base. Absent pour une note. */
  base?: string
  title: string
  /** D'ou vient le titre : un titre tire du nom suit les deplacements. */
  titleSource: TitleSource
  props: Record<string, PropertyValue>
  sections: Section[]
  links: LinkRef[]
  tags: string[]
  aliases: string[]
  created?: string
  modified?: string
}

export interface ExtractOptions {
  /** Types declares des proprietes (vault ou base) : ils priment sur la valeur lue. */
  schema?: PropertySchema
}

/** Ramene les proprietes aux types declares, sans perte (coercePropertyValue). */
export function applySchema(
  props: Record<string, PropertyValue>,
  schema: PropertySchema | undefined,
): Record<string, PropertyValue> {
  if (!schema?.properties.length) return props
  const out = { ...props }
  for (const def of schema.properties) {
    if (Object.prototype.hasOwnProperty.call(out, def.key)) out[def.key] = coercePropertyValue(out[def.key], def.type)
  }
  return out
}

function stringList(v: PropertyValue | undefined, split: RegExp | null): string[] {
  if (Array.isArray(v)) return v.map(String)
  if (typeof v === 'string') return split ? v.split(split) : [v]
  if (typeof v === 'number') return [String(v)]
  return []
}

/** Tags du frontmatter (`tags`, `tag`), sans '#'. */
export function frontmatterTags(props: Record<string, PropertyValue>): string[] {
  return [...stringList(props['tags'], /[,\s]+/), ...stringList(props['tag'], /[,\s]+/)]
    .map(t => t.trim().replace(/^#/, '').replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
}

/** Alias du frontmatter (`aliases`, `alias`). */
export function frontmatterAliases(props: Record<string, PropertyValue>): string[] {
  return [...stringList(props['aliases'], null), ...stringList(props['alias'], null)]
    .map(a => a.trim())
    .filter(Boolean)
}

function frontmatterTitle(props: Record<string, PropertyValue>): string | undefined {
  const t = props['title']
  if (typeof t === 'string' && t.trim()) return t.trim()
  if (typeof t === 'number') return String(t)
  return undefined
}

function distinctFold(list: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of list) {
    const k = s.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(s)
  }
  return out
}

/** Lit une note. */
export function extractNote(input: NoteInput, options: ExtractOptions = {}): NoteRecord {
  const ext = extOf(input.path)
  const useFrontmatter = input.frontmatter ?? ext === 'md'
  const block = useFrontmatter ? findFrontmatter(input.content) : null
  const props = applySchema(block ? parseFrontmatterYaml(block.yaml) : {}, options.schema)
  const body = block ? input.content.slice(block.end) : input.content
  const parts = parseMarkdownBody(body)

  const fmTitle = frontmatterTitle(props)
  const title = fmTitle ?? parts.h1 ?? stemOf(input.path)
  const titleSource: TitleSource = fmTitle !== undefined ? 'frontmatter' : parts.h1 !== undefined ? 'heading' : 'name'

  return {
    id: input.id,
    path: input.path,
    folder: folderOf(input.path),
    ext,
    title,
    titleSource,
    props,
    sections: parts.sections,
    links: parts.links,
    tags: distinctFold([...frontmatterTags(props), ...parts.tags]),
    aliases: distinctFold(frontmatterAliases(props)),
    ...(input.created ? { created: input.created } : {}),
    ...(input.modified ? { modified: input.modified } : {}),
  }
}

/**
 * Une note deja lue ailleurs (moteur en memoire, ligne legere de base) :
 * complete ce qui manque. Le texte devient une section sans titre.
 */
export function makeRecord(init: {
  id: string
  path: string
  title?: string
  base?: string
  props?: Record<string, PropertyValue>
  text?: string
  sections?: Section[]
  links?: LinkRef[]
  tags?: string[]
  aliases?: string[]
  created?: string
  modified?: string
}): NoteRecord {
  return {
    id: init.id,
    path: init.path,
    folder: folderOf(init.path),
    ext: extOf(init.path),
    ...(init.base !== undefined ? { base: init.base } : {}),
    title: init.title ?? stemOf(init.path),
    titleSource: init.title !== undefined ? 'given' : 'name',
    props: init.props ?? {},
    sections: init.sections ?? (init.text ? [{ text: init.text }] : []),
    links: init.links ?? [],
    tags: init.tags ?? [],
    aliases: init.aliases ?? [],
    ...(init.created ? { created: init.created } : {}),
    ...(init.modified ? { modified: init.modified } : {}),
  }
}

/** Texte brut d'une note : ses sections, une par ligne. */
export function recordText(record: Pick<NoteRecord, 'sections'>): string {
  return record.sections.map(s => s.text).join('\n')
}
