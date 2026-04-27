// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { CrdtVersion } from './CrdtVersion'

// Level 2 — document properties loaded at vault open, without loading the full document.
// Computed from markdown content (frontmatter + first H1). Persisted between sessions.
// crdtVersion tracks the doc version when this metadata was last computed;
// if FileTreeEntry.crdtVersion is higher, this metadata is potentially stale.
export interface DocMetadata {
  docId: string
  path: string
  crdtVersion: CrdtVersion
  title: string
  tags: string[]
  aliases: string[]
  frontmatter: Record<string, unknown>
}
