// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Notes du jour : une note par date, nommee `YYYY-MM-DD.md` (comme Obsidian),
// rangee dans `Journal/`. Une note du jour deja ailleurs dans le vault (un
// vault Obsidian les met a la racine) est reconnue a son nom.
import { formatDate, templateFolderOf } from '@savoire/plugin-api'

export const DAILY_FOLDER = 'Journal/'
/** Noms possibles du modele de la note du jour, dans le dossier des modeles. */
export const DAILY_TEMPLATE_NAMES = ['note du jour', 'journal', 'daily note', 'daily']

const DAY_RE = /(?:^|\/)(\d{4}-\d{2}-\d{2})\.md$/i

/** `2026-11-07` d'une date (jour local). */
export function dayKey(d: Date): string {
  return formatDate(d, 'YYYY-MM-DD')
}

/** La date d'un jour `YYYY-MM-DD`, a minuit (heure locale). */
export function dateOfKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** Les notes du jour du vault, par jour. `Journal/` passe avant les autres dossiers. */
export function dailyNotes(files: readonly string[]): Map<string, string> {
  const byDay = new Map<string, string>()
  for (const f of files) {
    const m = DAY_RE.exec(f)
    if (!m) continue
    const prev = byDay.get(m[1])
    if (!prev || (f.startsWith(DAILY_FOLDER) && !prev.startsWith(DAILY_FOLDER))) byDay.set(m[1], f)
  }
  return byDay
}

/** Le chemin de la note de ce jour : l'existante, sinon une neuve dans `Journal/`. */
export function dailyNotePath(key: string, files: readonly string[]): string {
  return dailyNotes(files).get(key) ?? `${DAILY_FOLDER}${key}.md`
}

/** Le modele de la note du jour, s'il existe. */
export function dailyTemplatePath(files: readonly string[]): string | null {
  const folder = templateFolderOf(files)
  if (!folder) return null
  return files.find(f => {
    if (!f.startsWith(folder) || !f.toLowerCase().endsWith('.md')) return false
    const name = f.slice(folder.length, -3).toLowerCase()
    return DAILY_TEMPLATE_NAMES.includes(name)
  }) ?? null
}

/** Les jours affiches pour un mois : semaines entieres, du lundi au dimanche. */
export function monthGrid(year: number, month: number): Date[] {
  const first = new Date(year, month, 1)
  const offset = (first.getDay() + 6) % 7
  const start = new Date(year, month, 1 - offset)
  const last = new Date(year, month + 1, 0)
  const days = Math.ceil((offset + last.getDate()) / 7) * 7
  return Array.from({ length: days }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i))
}
