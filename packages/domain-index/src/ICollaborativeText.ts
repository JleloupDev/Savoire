// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { RelPosJSON } from './AnchorHandle'

// Abstraction over a CRDT text type (e.g. Y.Text).
// Contributors use this interface — they never depend on Yjs directly.
export interface ICollaborativeText {
  toString(): string
  readonly length: number
  // assoc=0: right-sticky (anchor moves with the character it references when text is inserted before it)
  // assoc=-1: left-sticky (anchor stays when text is inserted after it)
  createRelPos(index: number, assoc: 0 | -1): RelPosJSON
  resolveRelPos(rp: RelPosJSON): number | null
  slice(start: number, end: number): string
}
