// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { CrdtVersion } from './CrdtVersion'

// Level 1 — minimal per-document record for file tree display and staleness detection.
// Gossiped between peers at connection time. Never contains document content.
export interface FileTreeEntry {
  docId: string
  path: string
  crdtVersion: CrdtVersion
}
