// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Nommage et resolution des pieces jointes, comme Obsidian. Fonctions pures :
// elles ne savent rien du stockage, donc valent pour tous les profils.

/** Dossier des pieces jointes du vault. */
export const ATTACHMENTS_DIR = 'attachments/'

/**
 * Nom de fichier sur pour un lien `![[...]]` : sans les caracteres qui
 * casseraient le lien ou le chemin ([ ] | # ^ \ / :).
 */
export function sanitizeFileName(name: string): string {
  const clean = name.replace(/[[\]|#^\\/:]+/g, ' ').replace(/\s+/g, ' ').trim()
  return clean.startsWith('.') ? `fichier${clean}` : clean || 'fichier'
}

function splitExtension(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? { base: name.slice(0, dot), ext: name.slice(dot) } : { base: name, ext: '' }
}

/**
 * Chemin libre dans `attachments/` pour ce nom. Si « Nom.png » est pris :
 * « Nom 1.png », puis « Nom 2.png »...
 */
export function uniqueAttachmentPath(name: string, isTaken: (path: string) => boolean): string {
  const { base, ext } = splitExtension(sanitizeFileName(name))
  let candidate = `${ATTACHMENTS_DIR}${base}${ext}`
  for (let n = 1; isTaken(candidate); n++) candidate = `${ATTACHMENTS_DIR}${base} ${n}${ext}`
  return candidate
}

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/**
 * Resout la cible d'un lien comme Obsidian : chemin exact d'abord ; sinon,
 * pour un nom sans dossier, le fichier qui porte ce nom (le chemin le plus
 * court s'il y en a plusieurs) ; sinon un chemin qui finit par la cible.
 */
export function resolveLinkPath(target: string, paths: readonly string[]): string | undefined {
  const t = target.trim().replace(/^\/+/, '')
  if (!t) return undefined
  if (paths.includes(t)) return t
  const shortest = (list: string[]): string | undefined =>
    list.sort((a, b) => a.length - b.length || a.localeCompare(b))[0]
  if (!t.includes('/')) return shortest(paths.filter(p => baseName(p) === t))
  return shortest(paths.filter(p => p.endsWith(`/${t}`)))
}

/**
 * Texte a mettre dans `![[...]]` pour ce chemin : son nom seul s'il est
 * unique dans le vault (comme Obsidian), sinon le chemin complet.
 */
export function linkTargetFor(path: string, paths: readonly string[]): string {
  const name = baseName(path)
  const sameName = paths.filter(p => baseName(p) === name)
  return sameName.length === 1 && sameName[0] === path ? name : path
}
