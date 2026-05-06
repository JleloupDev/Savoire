// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup

// Opaque JSON representation of a Y.RelativePosition — serialisable, stable across peers.
export type RelPosJSON = Record<string, unknown>

// Derives a deterministic string key from a RelPosJSON.
// Two peers anchoring the same CRDT character produce identical keys.
//
// DECISION: Yjs encodes relative positions as:
//   { tname?: string, type?: {client,clock}, item?: {client,clock}, assoc: number }
// - "item" is the CRDT item that holds the character — its clock encodes the character's
//   unique position within its parent item (clock = item.id.clock + intra-item offset).
//   This is the primary discriminator we want.
// - "tname" / "type" identify the container Y.Text, not the character.
//   Using only tname would give the same key for all positions in the same Y.Text.
// - When item is null (end-of-type sentinel), we fall back to tname/type.
export function anchorKey(rp: RelPosJSON): string {
  const item = rp['item'] as { client: number; clock: number } | null | undefined
  const type = rp['type'] as { client: number; clock: number } | null | undefined
  const tname = rp['tname'] as string | undefined
  const assoc = (rp['assoc'] as number | undefined) ?? 0
  // Prefer the content-item ID — distinguishes individual characters within the same Y.Item.
  const id = item ?? type
  if (id) return `${id.client}:${id.clock}:${assoc}`
  // No specific item — position is at the end of a named (root) type.
  return `tname:${tname ?? 'root'}:${assoc}`
}
