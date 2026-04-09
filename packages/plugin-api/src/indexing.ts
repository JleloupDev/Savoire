// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// ─── Content extraction (shadow documents) ──────────────────────────────
//
// A plugin that handles a non-Markdown file type can declare a ContentExtractor
// to produce an indexable Markdown shadow document.
// The extractor is isomorphic: it runs on both client and server (Node).
//
// Usage in a FileTypeSpec plugin:
//   contentExtractor: {
//     toShadowDocument(rawContent: string): string { ... }
//   }

export interface ContentExtractor {
  /**
   * Transforme le contenu brut d'un document (JSON, SVG, etc.) en Markdown indexable.
   * Le résultat est envoyé au serveur via POST /api/v1/vaults/{vaultId}/documents/{docId}/index.
   */
  toShadowDocument(rawContent: string): string
}

// ─── Index contributors ───────────────────────────────────────────────────
//
// A plugin can contribute to a persistent index (e.g. backlinks, tags).
// Model: ops log + snapshots. The server is the sequencer.
//
// Lifecycle:
//   1. restore(snapshot)       — on startup, restore state from the last snapshot
//   2. onOp(seq, docId, content) — for each op since processedSeq
//   3. snapshot()              — periodically, serialize state for persistence

export interface IndexContributor {
  /** Namespace unique de cet index (ex. "backlinks", "tags"). Utilisé comme clé de snapshot. */
  namespace: string
  /**
   * Restaure l'état interne depuis un snapshot persisté.
   * Appelé au démarrage si un snapshot existe côté serveur.
   */
  restore(snapshot: string, processedSeq: number): void
  /**
   * Traite une opération de contenu.
   * @param seq  Séquence serveur de l'op. null = op locale non encore séquencée (offline).
   * @param docId UUID stable du document.
   * @param path Chemin vault-relatif du document (ex. "Inbox/note.md").
   * @param markdownContent Contenu Markdown (shadow doc inclus) à indexer.
   */
  onOp(seq: number | null, docId: string, path: string, markdownContent: string): void
  /**
   * Sérialise l'état courant en JSON string pour persistance côté serveur.
   */
  snapshot(): string
  /** Dernière séquence traitée — utilisée pour le checkpoint. */
  readonly processedSeq: number
}

// ─── Index API (exposed to plugins) ──────────────────────────────────────

export interface IPluginIndexAPI {
  /** Enregistre un contributeur d'index. Appelé dans VaultPlugin.onload(). */
  register(contributor: IndexContributor): void
}

// ─── Index registry (used by application layer) ───────────────────────────
// Wider than IPluginIndexAPI — exposes read access for ContentIndexingService.

export interface IIndexRegistry extends IPluginIndexAPI {
  /** Returns all registered contributors. Used by ContentIndexingService. */
  getAll(): IndexContributor[]
}
