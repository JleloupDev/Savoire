// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import * as Y from 'yjs'
import type { ICollaborativeText, RelPosJSON } from '@savoire/domain-index'

// DECISION: TypeScript 5.9 + moduleResolution:bundler fails to follow Yjs's
// .js→.d.ts re-export chain for advanced APIs (createRelativePositionFromTypeIndex,
// relativePositionToJSON, etc.) and for inherited members (Y.Text.length).
// Cast once to bypass the type-level gap; runtime behaviour is validated by
// domain-index integration tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Y_ = Y as Record<string, any>

// Wraps a Y.Text + Y.Doc as an ICollaborativeText.
// Production implementation — lives in infrastructure-sync so Yjs stays out of domain code.
export class YjsCollaborativeText implements ICollaborativeText {
  constructor(
    private readonly ytext: Y.Text,
    private readonly ydoc: Y.Doc,
  ) {}

  toString(): string { return this.ytext.toString() }
  get length(): number { return this.ytext.toString().length }

  createRelPos(index: number, assoc: 0 | -1): RelPosJSON {
    const rp = Y_.createRelativePositionFromTypeIndex(this.ytext, index, assoc) as unknown
    return Y_.relativePositionToJSON(rp) as RelPosJSON
  }

  resolveRelPos(rp: RelPosJSON): number | null {
    const abs = Y_.createAbsolutePositionFromRelativePosition(
      Y_.createRelativePositionFromJSON(rp),
      this.ydoc,
    ) as { index: number } | null
    return abs?.index ?? null
  }

  slice(start: number, end: number): string {
    return this.ytext.toString().slice(start, end)
  }
}
