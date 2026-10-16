// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Corbeille du vault, comme Obsidian : un dossier `.trash/` a la racine.
// Mettre a la corbeille = renommer le document sous `.trash/`, en gardant son
// chemin d'origine. Ce n'est qu'un renommage dans le repertoire CRDT : il
// marche dans tous les profils (serveur, pair a pair), sans rien cote serveur.
//
// Le chemin d'origine vit dans le chemin lui-meme (`.trash/<chemin>`). Pas de
// carte a part : rien a synchroniser en plus, rien qui puisse diverger du
// repertoire. Seule perte : en cas de collision dans la corbeille, le
// document prend un suffixe (« Note 1.md ») et revient sous ce nom.
//
// Fonctions pures : elles ne savent rien du stockage.

/** Dossier de la corbeille, a la racine du vault. */
export const TRASH_DIR = '.trash/'

/** Vrai si le chemin est dans la corbeille. */
export function isTrashPath(path: string): boolean {
  return path.startsWith(TRASH_DIR)
}

function splitExtension(path: string): { base: string; ext: string } {
  const slash = path.lastIndexOf('/')
  const dot = path.lastIndexOf('.')
  return dot > slash + 1 ? { base: path.slice(0, dot), ext: path.slice(dot) } : { base: path, ext: '' }
}

/** Premier chemin libre : le chemin lui-meme, sinon « Nom 1.ext », « Nom 2.ext »... */
function uniquePath(path: string, isTaken: (path: string) => boolean): string {
  if (!isTaken(path)) return path
  const { base, ext } = splitExtension(path)
  let n = 1
  while (isTaken(`${base} ${n}${ext}`)) n++
  return `${base} ${n}${ext}`
}

/** Chemin dans la corbeille d'un document : `.trash/<chemin>`, suffixe si pris. */
export function trashPathFor(path: string, isTaken: (path: string) => boolean): string {
  return uniquePath(TRASH_DIR + path, isTaken)
}

/** Chemin d'origine d'un document de la corbeille (sans le prefixe `.trash/`). */
export function originalPathOf(trashPath: string): string {
  return isTrashPath(trashPath) ? trashPath.slice(TRASH_DIR.length) : trashPath
}

/** Chemin de restauration : le chemin d'origine, suffixe s'il a ete repris entre-temps. */
export function restorePathFor(trashPath: string, isTaken: (path: string) => boolean): string {
  return uniquePath(originalPathOf(trashPath), isTaken)
}
