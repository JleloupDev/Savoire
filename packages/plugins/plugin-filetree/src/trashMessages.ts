// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Textes des fenetres de confirmation de la corbeille. Fonctions pures.
import type { DialogRequest } from './TrashPanel'

/** « 1 fichier », « 3 fichiers » */
export function filesLabel(n: number): string {
  return n === 1 ? '1 fichier' : `${n} fichiers`
}

/** Mettre un dossier simple a la corbeille : dit combien de fichiers partent. */
export function trashFolderRequest(name: string, fileCount: number): DialogRequest {
  if (fileCount === 0) {
    return { title: 'Retirer le dossier', message: `Le dossier « ${name} » est vide. Le retirer ?`, confirmLabel: 'Retirer', danger: true }
  }
  return {
    title: 'Mettre le dossier a la corbeille',
    message: `Le dossier « ${name} » contient ${filesLabel(fileCount)}. ${fileCount === 1 ? 'Il sera mis' : 'Ils seront mis'} a la corbeille.`,
    confirmLabel: 'Mettre a la corbeille',
    danger: true,
  }
}

/** Note de dossier : ses sous-pages partent-elles aussi ? */
export function trashSubPagesRequest(name: string, fileCount: number): DialogRequest {
  return {
    title: 'Mettre la note a la corbeille',
    // Le dossier d'une note contient ses sous-pages ET ses images.
    message: `Le dossier de « ${name} » contient ${fileCount === 1 ? '1 element' : `${fileCount} elements`} (sous-pages, images...). ${fileCount === 1 ? 'Le mettre' : 'Les mettre'} aussi a la corbeille ?`,
    confirmLabel: 'Tout mettre a la corbeille',
    altLabel: 'Garder le dossier',
    danger: true,
  }
}

/** Vider la corbeille. */
export function emptyTrashRequest(count: number): DialogRequest {
  return {
    title: 'Vider la corbeille',
    message: `${filesLabel(count)} ${count === 1 ? 'sera supprime' : 'seront supprimes'} definitivement. Cette action est irreversible.`,
    confirmLabel: 'Vider la corbeille',
    danger: true,
  }
}
