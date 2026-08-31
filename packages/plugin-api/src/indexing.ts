// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup

// Re-export domain types — plugins only depend on plugin-api, never on domain-index directly.
export type {
  RelPosJSON,
  ICollaborativeText,
  IndexEntry,
  IndexContributor,
  AnyIndexContributor,
  LocalIndexContributor,
  AnchorContributor,
  SharedIndexEntry,
  CrdtVersion,
  DocMetadata,
  FileTreeEntry,
} from '@savoire/domain-index'
export { AnchorIndex, resolveEntry, validateEntry } from '@savoire/domain-index'
export { anchorKey } from '@savoire/domain-index'

// ─── Content extraction (shadow documents) ──────────────────────────────────
//
// A plugin that handles a non-Markdown file type can declare a ContentExtractor
// to produce an indexable Markdown shadow document.
// The extractor is isomorphic: it runs on both client and server (Node).

export interface ContentExtractor {
  toShadowDocument(rawContent: string): string
}

// ─── Index store API (read-only, exposed to plugins) ─────────────────────────
// ISP: plugins that only need to query the index receive this narrow interface.

export interface IIndexStoreAPI {
  query(namespace: string): import('@savoire/domain-index').IndexEntry[]
  getByValue(namespace: string, value: string): import('@savoire/domain-index').IndexEntry[]
  getByDoc(namespace: string, docId: string): import('@savoire/domain-index').IndexEntry[]
}

// ─── Contributor registry (write-only, exposed to plugins) ───────────────────
// ISP: plugins that register contributors receive this narrow interface.

export interface IIndexContributorRegistry {
  /**
   * Enregistre une fabrique — une instance neuve est creee a chaque changement
   * de vault. Un plugin peut ainsi exposer son propre index, partage entre
   * pairs sans qu'il ait a s'occuper du transport (voir IndexContributor).
   */
  registerFactory(factory: () => import('@savoire/domain-index').AnyIndexContributor): void
}

// ─── Combined (used by application layer wiring) ─────────────────────────────

export interface IPluginIndexAPI extends IIndexContributorRegistry {}

// ─── Index registry (used by application layer) ───────────────────────────────
// Wider than IPluginIndexAPI — exposes contributor list for ContentIndexingService.

export interface IIndexRegistry extends IPluginIndexAPI {
  getAll(): import('@savoire/domain-index').AnyIndexContributor[]
  get(namespace: string): import('@savoire/domain-index').AnyIndexContributor | undefined
  /** Recreates all contributor instances from their registered factories. */
  rebuild(): void
}
