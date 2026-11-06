// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Ce que propose le menu apres « ! » :
//   !gen          les chapitres dont le nom ou un alias contient « gen » ;
//   !Gen 1:       tous les versets du chapitre ;
//   !Gen 1:3-5    ces versets (une seule entree) ;
//   !Gen 1:lumiere  les versets du chapitre qui contiennent ce mot ;
//   !lumiere      sans chapitre reconnu : les versets de toute la Bible.
// Choisir un chapitre ecrit « !Genese 1: » et garde le menu ouvert pour le
// verset ; choisir un verset ecrit ses integrations ![[Genese 1#^3]].
import type { TriggerItem } from '@savoire/plugin-api'
import { normalize } from './references'
import type { ReferenceParser, VerseTarget } from './parse'

export interface QuickRefSettings {
  /** Dossier des references (« Bible/ »). */
  folder: string
  /** Caractere qui ouvre le menu. */
  trigger: string
  /** Separateur chapitre / verset. */
  separator: string
}

export const DEFAULT_SETTINGS: QuickRefSettings = { folder: 'Bible/', trigger: '!', separator: ':' }

/** Resultats d'une recherche de mot dans tout le dossier, au plus. */
export const GLOBAL_SEARCH_LIMIT = 40
const PREVIEW_MAX = 160

/** Texte du lien vers une note (nom si unique, sinon chemin). */
export type LinkTarget = (path: string) => string

export function embedOf(target: VerseTarget, linkTarget: LinkTarget): string {
  return `![[${linkTarget(target.info.path)}#^${target.verse}]]`
}

function clip(text: string): string {
  return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX - 1)}…` : text
}

function verseItem(label: string, preview: string[], targets: VerseTarget[], linkTarget: LinkTarget): TriggerItem {
  return {
    id: `quickref:${targets.map(t => `${t.info.path}#${t.verse}`).join(',')}`,
    label,
    description: clip(preview.join(' ')),
    icon: '📖',
    category: 'Versets',
    insert: targets.map(t => embedOf(t, linkTarget)).join('\n'),
  }
}

function singleVerse(label: string, t: VerseTarget, linkTarget: LinkTarget, sep: string): TriggerItem {
  return verseItem(`${label}${sep}${t.verse}`, [t.info.verses.get(t.verse) ?? ''], [t], linkTarget)
}

export function suggest(
  parser: ReferenceParser,
  query: string,
  settings: QuickRefSettings,
  linkTarget: LinkTarget,
): TriggerItem[] {
  const sep = settings.separator
  const at = query.indexOf(sep)
  if (at > 0) {
    const chapterPart = query.slice(0, at)
    const versePart = query.slice(at + 1).trim()
    const resolved = parser.resolveChapter(chapterPart)
    if (!resolved) return []
    const label = chapterPart.trim()
    if (!versePart) {
      // Rien apres le separateur : tous les versets, a parcourir aux fleches.
      return [...resolved.info.verses.keys()].sort((a, b) => a - b)
        .map(v => singleVerse(label, { info: resolved.info, verse: v }, linkTarget, sep))
    }
    const parsed = parser.parseVerses(resolved, chapterPart, versePart)
    if (parsed) return [verseItem(parsed.label, parsed.preview, parsed.targets, linkTarget)]
    // Pas un numero : un mot cherche dans le chapitre.
    return parser.search(versePart, Infinity, resolved.info)
      .map(t => singleVerse(label, t, linkTarget, sep))
  }

  const chapters = parser.chapters(normalize(query))
  if (chapters.length) {
    return chapters.slice(0, 50).map(info => ({
      id: `quickref:chapter:${info.path}`,
      label: info.name,
      description: clip(info.verses.get(1) ?? ''),
      icon: '📖',
      category: 'Chapitres',
      // Un chapitre a versets : on complete la reference et le menu reste
      // ouvert pour le verset. Sans versets : un lien vers la note.
      insert: info.lastVerse > 0
        ? `${settings.trigger}${info.name}${sep}`
        : `![[${linkTarget(info.path)}|${info.name}]]`,
      keepOpen: info.lastVerse > 0,
    }))
  }

  // Ni livre ni chapitre : le mot dans toute la Bible.
  return parser.search(query, GLOBAL_SEARCH_LIMIT)
    .map(t => singleVerse(t.info.name, t, linkTarget, sep))
}
