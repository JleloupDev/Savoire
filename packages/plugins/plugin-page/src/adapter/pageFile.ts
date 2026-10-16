// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Le fichier .page en mode local : le document ProseMirror en JSON,
// dans une enveloppe versionnee.
//
//   { "format": "savoire-page", "version": 1, "doc": { "type": "doc", ... } }
//
// Un fichier vide est une page vide (c'est ce que rend FileTypeSpec.create).
import type { PmJson } from './convert'

export const PAGE_FORMAT = 'savoire-page'
export const PAGE_VERSION = 1

export class PageFileError extends Error {}

/** Lit un fichier .page. null = page vide. Leve PageFileError s'il est illisible. */
export function parsePageFile(raw: string): PmJson | null {
  if (!raw.trim()) return null
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    throw new PageFileError('Le fichier n\'est pas du JSON.')
  }
  const env = data as { format?: unknown; version?: unknown; doc?: unknown }
  if (env?.format !== PAGE_FORMAT) throw new PageFileError('Ce n\'est pas une page Savoire.')
  if (typeof env.version !== 'number' || env.version > PAGE_VERSION) {
    throw new PageFileError('Version de page inconnue : mettez le plugin a jour.')
  }
  const doc = env.doc as PmJson | undefined
  if (!doc || doc.type !== 'doc') throw new PageFileError('Document manquant.')
  return doc
}

/** Ecrit un fichier .page. */
export function stringifyPageFile(doc: PmJson): string {
  return JSON.stringify({ format: PAGE_FORMAT, version: PAGE_VERSION, doc }, null, 2) + '\n'
}
