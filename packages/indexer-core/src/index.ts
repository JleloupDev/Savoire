// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Noyau d'indexation partage (ADR-027, etape 2). Sans DOM ni API Node :
// le pilote node:sqlite est dans l'entree separee @savoire/indexer-core/node.
export { sql } from './driver'
export type { SqlDriver, SqlRow, SqlStatement, SqlValue } from './driver'
export { IndexError } from './errors'
export type { IndexErrorCode } from './errors'
export { foldText, words, tokenize, compareValues, isEmptyValue } from './text'
export type { TextToken } from './text'
export {
  TRASH_PREFIX, NOTE_EXTENSIONS, ATTACHMENT_EXTENSIONS, isTrashPath, folderOf, nameOf, extOf, stemOf,
  normalizePath, resolveFrom,
} from './paths'

export { parseMarkdownBody } from './extract/markdown'
export type { MarkdownParts, Section, LinkRef } from './extract/markdown'
export { extractNote, makeRecord, applySchema, recordText, frontmatterTags, frontmatterAliases } from './extract/note'
export type { NoteInput, NoteRecord, TitleSource, ExtractOptions } from './extract/note'

export { loadDoc, withDoc, fromBase64 } from './crdt/yjs'
export type { YjsUpdate } from './crdt/yjs'
export { readVaultTree, vaultTreeFromUpdates, diffTree, VAULT_MAP, FOLDERS_MAP } from './crdt/tree'
export type { VaultTree, TreeDiff } from './crdt/tree'
export {
  readDocContent, noteInputFromUpdates, pageMarkdown, excalidrawMarkdown, mindmapMarkdown,
  TEXT_NAME, TREE_ROOT, PAGE_KEY,
} from './crdt/content'
export type { DocContent } from './crdt/content'

export { method } from './power'
export type { IndexPower, PowerContext, PowerMethod, MethodOptions, DocRef, Statements } from './power'
export { defaultPowers, queryPower, searchPower, linksPower, tagsPower, statusPower } from './powers'
export { MAX_GROUPS } from './powers/query'
export type { QueryApi, TextSearchApi } from './powers/query'
export { parseSearchText, buildSnippets, findMatches } from './powers/snippets'
export type { SearchTerms } from './powers/snippets'
export { linkKeys } from './powers/links'
export type { IndexStatus } from './powers/status'
export type { Frag } from './powers/filter'

export { VaultIndex } from './VaultIndex'
export type { VaultIndexOptions, WriteOptions, MoveResult, IndexInspection } from './VaultIndex'
export { CORE_VERSION } from './core'
