// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Bibliotheques communes fournies par Savoire aux plugins.
//
// Un plugin venu d'ailleurs que le depot (store externe) ne doit pas
// embarquer sa propre copie de React ou de CodeMirror : son paquet serait
// lourd, et deux React dans la meme page ne se parlent pas. Savoire fournit
// donc une liste fermee de bibliotheques, toujours dans SA version ; le
// plugin les declare « externes » a la construction et les obtient par
// `require('react')` (format CommonJS), comme les plugins d'Obsidian obtiennent
// `require('obsidian')`.
//
// La liste est volontairement courte. Yjs n'y est pas : les plugins passent
// par l'API CRDT de Savoire (texte, arbre, carte), jamais par la bibliotheque.

export const SHARED_LIBRARIES = [
  '@savoire/plugin-api',
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@codemirror/state',
  '@codemirror/view',
  '@codemirror/language',
  '@codemirror/commands',
] as const

export type SharedLibraryId = typeof SHARED_LIBRARIES[number]

export function isSharedLibrary(id: string): id is SharedLibraryId {
  return (SHARED_LIBRARIES as readonly string[]).includes(id)
}

/** Les bibliotheques communes, cote plugin. */
export interface ISharedLibraries {
  /** Ce que cet hote fournit. */
  list(): SharedLibraryId[]
  /** La bibliotheque, si elle est deja chargee (sinon : load()). */
  get<T = unknown>(id: SharedLibraryId): T
  /** Charge une bibliotheque (une fois ; ensuite get() la rend tout de suite). */
  load<T = unknown>(id: SharedLibraryId): Promise<T>
}

/** Une bibliotheque demandee qui n'est pas dans la liste commune. */
export class UnknownLibraryError extends Error {
  constructor(readonly id: string) {
    super(`Bibliothèque non fournie par Savoire : « ${id} ». Embarquez-la dans le plugin, ou utilisez une des bibliothèques communes (${SHARED_LIBRARIES.join(', ')}).`)
  }
}
