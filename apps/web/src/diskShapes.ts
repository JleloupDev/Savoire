// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Sur le disque, chaque document a un fichier lisible. Ce que le fichier
// contient depend du type declare par son plugin (FileTypeSpec) :
//  - texte CRDT (Markdown, .tex, .wtf, .outline, .board) : le texte, dans les
//    deux sens (une modification faite ailleurs est reprise) ;
//  - arbre CRDT (carte mentale, dessin, page, base, discussion) : l'arbre en
//    JSON, a chaque modification (sens unique) ;
//  - le reste (instantanes, binaires) : le fichier lui-meme.
// Le registre des types est branche au demarrage des plugins.
import type { FileSystemVaultSessionOptions } from '@savoire/infrastructure-sync'
import type { FileTypeSpec } from '@savoire/plugin-api'

type Resolve = (extension: string) => FileTypeSpec | undefined

let resolve: Resolve | null = null

/** Le registre des types de fichier (plugins charges). */
export function setDiskTypeResolver(r: Resolve | null): void {
  resolve = r
}

/** Types connus meme avant le chargement des plugins. */
const TEXT_BY_DEFAULT = new Set(['md', 'markdown', 'txt', 'outline'])

function extOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function isTextDocumentPath(path: string): boolean {
  const ext = extOf(path)
  const spec = resolve?.(ext)
  if (!spec) return TEXT_BY_DEFAULT.has(ext)
  return spec.collaborationMode === 'crdt' && (spec.superType ?? 'text') === 'text' && (spec.crdtRoot ?? 'text') === 'text'
    || (ext === 'md')
}

export function isTreeDocumentPath(path: string): boolean {
  const spec = resolve?.(extOf(path))
  return !!spec && spec.collaborationMode === 'crdt' && spec.crdtRoot === 'tree'
}

/** Options des sessions sur disque : fichiers lisibles selon le type. */
export const diskSessionOptions: FileSystemVaultSessionOptions = {
  isTextDocument: isTextDocumentPath,
  isTreeDocument: isTreeDocumentPath,
}

/** Extensions toujours binaires (octets gardes tels quels), meme sans plugin. */
const BINARY_BY_DEFAULT = new Set(['pdf', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'doc', 'xls', 'ppt', 'zip', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'mp3', 'mp4', 'wav', 'mov'])

/** Un fichier binaire : copie telle quelle d'un vault a l'autre, lu par les extracteurs. */
export function isBinaryDocumentPath(path: string): boolean {
  const ext = extOf(path)
  return resolve?.(ext)?.superType === 'binary' || BINARY_BY_DEFAULT.has(ext)
}
