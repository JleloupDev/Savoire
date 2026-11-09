// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Extracteurs : lire le contenu d'un fichier que Savoire n'edite pas (Word,
// PowerPoint, Excel, OpenDocument, HTML, CSV, images...) pour l'index et pour
// un apercu.
//
// Un extracteur est fourni par un plugin. Il recoit les octets du fichier et
// rend du texte (des sections), un titre, des proprietes. L'application s'en
// sert pour :
//  - la recherche et les requetes : le fichier devient une entree de l'index,
//    comme une note (ses proprietes sont interrogeables) ;
//  - l'apercu en lecture seule, quand l'extracteur sait en dessiner un.
//
// Fonctions pures, sans reseau : elles tournent la ou tourne l'index.
import type { PropertyValue } from './properties'

export interface ExtractedSection {
  /** Titre de la section (une diapositive, une feuille, un titre du document). */
  heading?: string
  text: string
  /** Donnees en tableau (feuille de calcul, CSV) : l'apercu les dessine en tableau. */
  rows?: string[][]
}

export interface ExtractedContent {
  title?: string
  sections: ExtractedSection[]
  /** Proprietes (auteur, date, dimensions...), interrogeables comme le frontmatter d'une note. */
  props?: Record<string, PropertyValue>
}

export interface ExtractorSpec {
  id: string
  /** Nom affiche (« Documents Word »). */
  label: string
  /** Extensions traitees, sans point, en minuscules. */
  extensions: string[]
  /** Version : la changer fait relire les fichiers deja extraits. */
  version?: number
  extract(bytes: Uint8Array, info: { path: string }): Promise<ExtractedContent>
  /** Apercu en lecture seule. Absent : l'apercu generique (texte des sections). */
  preview?(bytes: Uint8Array, info: { path: string }): Promise<HTMLElement> | HTMLElement
}

export interface ExtractorRegistry {
  /** Rend la fonction qui retire l'extracteur. */
  register(spec: ExtractorSpec): () => void
  /** L'extracteur d'un chemin, d'apres son extension. */
  forPath(path: string): ExtractorSpec | undefined
  list(): ExtractorSpec[]
  onChange(cb: () => void): () => void
}

/** Taille maximale d'un fichier lu par un extracteur (octets). */
export const MAX_EXTRACT_BYTES = 25 * 1024 * 1024

const yamlValue = (v: PropertyValue): string => {
  if (v === null) return 'null'
  if (Array.isArray(v)) return `[${v.map(x => JSON.stringify(x)).join(', ')}]`
  if (typeof v === 'string') return JSON.stringify(v)
  return String(v)
}

/**
 * Le contenu extrait, vu comme une note Markdown : proprietes en frontmatter,
 * titre, sections. C'est ce que l'index lit (meme lecteur que les notes).
 */
export function extractedToMarkdown(content: ExtractedContent): string {
  const parts: string[] = []
  const props = Object.entries(content.props ?? {}).filter(([k]) => /^[\p{L}\p{N}_][\p{L}\p{N}_ -]*$/u.test(k))
  if (props.length) parts.push(`---\n${props.map(([k, v]) => `${k}: ${yamlValue(v)}`).join('\n')}\n---`)
  if (content.title) parts.push(`# ${content.title.replace(/\n/g, ' ')}`)
  for (const s of content.sections) {
    if (s.heading) parts.push(`## ${s.heading.replace(/\n/g, ' ')}`)
    if (s.text.trim()) parts.push(s.text.trim())
  }
  return parts.join('\n\n') + '\n'
}

/** Extension d'un chemin, sans point, en minuscules. */
export function extensionOfPath(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}
