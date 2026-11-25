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

// ── Ancres des agents (agent-core/anchor.ts) ────────────────────────────────
//
// start et end d'une ancre : une position relative Yjs, encodee
// (Y.encodeRelativePosition) puis mise en base64. ICollaborativeText parle en
// JSON (RelPosJSON) : ces deux fonctions font le passage.

/** Une position relative (JSON) en base64, pour une ancre. */
export function relPosToBase64(rp: RelPosJSON): string {
  const bytes = Y_.encodeRelativePosition(Y_.createRelativePositionFromJSON(rp)) as Uint8Array
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!)
  return btoa(bin)
}

/** La position relative (JSON) d'une ancre. Null : illisible. */
export function relPosFromBase64(b64: string): RelPosJSON | null {
  try {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return Y_.relativePositionToJSON(Y_.decodeRelativePosition(bytes)) as RelPosJSON
  } catch {
    return null
  }
}
