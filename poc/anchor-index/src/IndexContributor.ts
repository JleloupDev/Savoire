// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type * as Y from 'yjs'
import type { AnchorIndex } from './AnchorIndex'

// ── IndexContributor — pour les entrées ancrées dans le Y.Text ────────────────
//
// onOp     : appelé après stabilisation (texte complet, flux existant)
// onYjsChange : appelé par l'observer Y.Text en temps réel — contributor
//              valide ses anchres et rescanne si nécessaire
//
// Le contributor décide lui-même de l'ID de chaque IndexEntry.
// L'AnchorIndex est un store muet : il ne génère pas d'IDs.

export interface IndexContributor {
  readonly namespace: string
  readonly processedSeq: number
  restore(snapshot: string, processedSeq: number): void
  snapshot(): string
  onOp(seq: number | null, docId: string, path: string, markdownContent: string): void
  onYjsChange?(ytext: Y.Text, ydoc: Y.Doc, docId: string, index: AnchorIndex): void
}

// ── MetadataContributor — pour les singletons hors Y.Text (Pattern C) ─────────
//
// Pas d'anchres. Appelé à l'ouverture d'un doc ou sur renommage.
// L'ID est typiquement `${namespace}|${docId}`.

export interface MetadataContributor {
  readonly namespace: string
  processPath(docId: string, path: string, index: AnchorIndex): void
}
