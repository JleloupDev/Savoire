// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Nommage et resolution des pieces jointes, comme Obsidian. Fonctions pures :
// elles ne savent rien du stockage, donc valent pour tous les profils.

/** Dossier des pieces jointes du vault (et des envois hors d'une note). */
export const ATTACHMENTS_DIR = 'attachments/'

/**
 * Ou range-t-on une image collee, deposee ou choisie depuis une note ?
 *   'note-folder'  : dans le dossier de la note (`Dossier/Ma note.md` ->
 *                    `Dossier/Ma note/`), affiche sous la note comme une note
 *                    de dossier. Supprimer la note propose d'emmener ce
 *                    dossier ; partager la note donne la lecture de ces images.
 *   'attachments'  : dans `attachments/`, l'ancien comportement.
 */
export type AttachmentLocation = 'note-folder' | 'attachments'

/** Choix par defaut : les images vivent avec leur note. */
export const ATTACHMENT_LOCATION: AttachmentLocation = 'note-folder'

/** Extensions des pieces jointes (celles que le serveur accepte). */
export const ATTACHMENT_EXTENSIONS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'])

/** Vrai si ce chemin designe une piece jointe (image). */
export function isAttachmentPath(path: string): boolean {
  const name = baseName(path)
  const dot = name.lastIndexOf('.')
  return dot > 0 && ATTACHMENT_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
}

/** Dossier d'une note : `Dossier/Ma note.md` -> `Dossier/Ma note/`. `''` sans extension. */
export function noteFolderOf(notePath: string): string {
  const slash = notePath.lastIndexOf('/')
  const name = notePath.slice(slash + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? `${notePath.slice(0, slash + 1)}${name.slice(0, dot)}/` : ''
}

/** Dossier ou ranger une piece jointe envoyee depuis cette note (ou hors note). */
export function attachmentFolderFor(notePath?: string, location: AttachmentLocation = ATTACHMENT_LOCATION): string {
  if (location !== 'note-folder' || !notePath) return ATTACHMENTS_DIR
  return noteFolderOf(notePath) || ATTACHMENTS_DIR
}

const NOTE_PRIORITY = ['page', 'md']

/**
 * Note qui porte ce dossier (`A/Projet/` -> `A/Projet.page` ou `A/Projet.md`),
 * avec la regle de l'arborescence : `.page`, puis `.md`, puis l'ordre
 * alphabetique. Undefined si aucune.
 */
export function folderNoteOf(folderPath: string, paths: readonly string[]): string | undefined {
  const folder = folderPath.endsWith('/') ? folderPath : `${folderPath}/`
  const rank = (p: string): number => {
    const i = NOTE_PRIORITY.indexOf(p.slice(p.lastIndexOf('.') + 1))
    return i === -1 ? NOTE_PRIORITY.length : i
  }
  return paths
    .filter(p => !p.endsWith('/') && noteFolderOf(p) === folder)
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))[0]
}

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
 * Chemin libre dans `dir` (par defaut `attachments/`) pour ce nom. Si
 * « Nom.png » est pris : « Nom 1.png », puis « Nom 2.png »...
 */
export function uniqueAttachmentPath(name: string, isTaken: (path: string) => boolean, dir: string = ATTACHMENTS_DIR): string {
  const folder = !dir || dir.endsWith('/') ? dir : `${dir}/`
  const { base, ext } = splitExtension(sanitizeFileName(name))
  let candidate = `${folder}${base}${ext}`
  for (let n = 1; isTaken(candidate); n++) candidate = `${folder}${base} ${n}${ext}`
  return candidate
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

// Resolution des liens par nom (comme Obsidian) : une seule regle pour toute
// l'appli, dans plugin-api (links.ts).
export { resolveLinkPath, linkTargetFor } from '@savoire/plugin-api'
