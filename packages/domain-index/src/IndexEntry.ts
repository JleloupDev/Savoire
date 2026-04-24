// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { RelPosJSON } from './AnchorHandle'

export interface IndexEntry {
  /** Deterministic ID: `namespace|docId|anchorKey(a1)|anchorKey(a2)` or `namespace|docId` for singletons. */
  id: string
  namespace: string
  /** Indexed value (e.g. "#salut", "Introduction", "My Note"). */
  value: string
  docId: string
  /** Left anchor — right-sticky, assoc=0. Undefined for metadata entries (filename, date). */
  anchor1?: RelPosJSON
  /** Right anchor — left-sticky, assoc=-1. Undefined for metadata entries. */
  anchor2?: RelPosJSON
  /** Contributor-specific metadata (e.g. { level: number } for headings). */
  meta?: unknown
}
