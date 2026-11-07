// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Modeles de notes, comme le plugin core « Modeles » d'Obsidian : une note
// du dossier des modeles, dont les variables sont remplacees a l'insertion.
//
//   {{title}}          nom de la note (sans .md)
//   {{date}}           date du jour, YYYY-MM-DD
//   {{time}}           heure, HH:mm
//   {{date:FORMAT}}    date dans un format : YYYY YY MMMM MMM MM M DD D dddd ddd
//   {{time:FORMAT}}    heure dans un format : HH H mm ss
//
// Le texte entre crochets d'un format reste tel quel : {{date:[Semaine] WW}}.
// Partage par plugin-templates et plugin-agenda (note du jour).

/** Dossiers ou chercher les modeles, dans l'ordre (le premier present gagne). */
export const TEMPLATE_FOLDERS = ['Modèles/', 'Modeles/', 'Templates/'] as const

const pad = (n: number, width = 2) => String(n).padStart(width, '0')

/** Numero de semaine ISO 8601. */
function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - day)
  const start = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
  return Math.ceil(((t.getTime() - start.getTime()) / 86_400_000 + 1) / 7)
}

/** Une date dans un format a la Moment (sous-ensemble courant). */
export function formatDate(d: Date, format: string, locale = 'fr-FR'): string {
  const name = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, opts).format(d)
  const tokens: Record<string, () => string> = {
    YYYY: () => String(d.getFullYear()),
    YY: () => String(d.getFullYear()).slice(-2),
    MMMM: () => name({ month: 'long' }),
    MMM: () => name({ month: 'short' }),
    MM: () => pad(d.getMonth() + 1),
    M: () => String(d.getMonth() + 1),
    DD: () => pad(d.getDate()),
    D: () => String(d.getDate()),
    dddd: () => name({ weekday: 'long' }),
    ddd: () => name({ weekday: 'short' }),
    WW: () => pad(isoWeek(d)),
    W: () => String(isoWeek(d)),
    HH: () => pad(d.getHours()),
    H: () => String(d.getHours()),
    mm: () => pad(d.getMinutes()),
    ss: () => pad(d.getSeconds()),
  }
  return format.replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|WW|W|HH|H|mm|ss/g,
    (m, literal: string | undefined) => literal ?? tokens[m]())
}

export interface TemplateContext {
  /** Nom de la note (sans .md). */
  title: string
  /** Date et heure a utiliser (defaut : maintenant). */
  date?: Date
}

/** Remplace les variables d'un modele. Une variable inconnue reste telle quelle. */
export function renderTemplate(template: string, ctx: TemplateContext): string {
  const date = ctx.date ?? new Date()
  return template.replace(/\{\{\s*(title|date|time)\s*(?::([^}]*))?\}\}/gi, (_m, name: string, format: string | undefined) => {
    switch (name.toLowerCase()) {
      case 'title': return ctx.title
      case 'date': return formatDate(date, format?.trim() || 'YYYY-MM-DD')
      default: return formatDate(date, format?.trim() || 'HH:mm')
    }
  })
}

/** Nom d'une note d'apres son chemin : `A/Ma note.md` -> `Ma note`. */
export function noteTitleOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '')
}

/** Le dossier des modeles d'un vault, d'apres ses fichiers ; null s'il n'y en a pas. */
export function templateFolderOf(files: readonly string[]): string | null {
  const lower = files.map(f => f.toLowerCase())
  for (const folder of TEMPLATE_FOLDERS) {
    const f = folder.toLowerCase()
    if (lower.some(p => p.startsWith(f))) {
      // La casse du vault : `modèles/` reste `modèles/`.
      const hit = files[lower.findIndex(p => p.startsWith(f))]
      return hit.slice(0, folder.length)
    }
  }
  return null
}
