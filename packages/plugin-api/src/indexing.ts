// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// ─── Content extraction (shadow documents) ──────────────────────────────
//
// Un plugin qui gère un type de fichier non-Markdown peut déclarer un ContentExtractor
// pour produire un document shadow Markdown indexable.
// L'extracteur est isomorphique : il fonctionne côté client ET côté serveur (Node).
//
// Usage dans un plugin FileTypeSpec :
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
// Un plugin peut contribuer à un index persistant (ex. backlinks, tags).
// Modèle M1 : ops log + snapshots. Le serveur est le séquenceur.
//
// Cycle de vie :
//   1. restore(snapshot)  — au démarrage, restaure l'état depuis le dernier snapshot
//   2. onOp(seq, docId, content) — pour chaque op depuis processedSeq
//   3. snapshot()         — périodiquement, sérialise l'état pour persistance

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
