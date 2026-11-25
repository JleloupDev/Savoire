// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Position relative Yjs en texte court : Y.encodeRelativePosition, puis
// base64. C'est la forme des ancres donnees a l'IA (contexte de l'editeur,
// epingles, surlignages) : le serveur et le pair les relisent sans connaitre
// le JSON de Yjs.
import * as Y from 'yjs'
import type { RelPosJSON } from '@savoire/domain-index'
import { base64ToBytes, bytesToBase64 } from './base64'

// Meme contournement que YjsCollaborativeText : les types de ces fonctions
// de Yjs ne passent pas la resolution de modules.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Y_ = Y as Record<string, any>

/** La position relative (JSON de ICollaborativeText.createRelPos) en base64. */
export function encodeRelPos(rp: RelPosJSON): string {
  return bytesToBase64(Y_.encodeRelativePosition(Y_.createRelativePositionFromJSON(rp)) as Uint8Array)
}

/** L'inverse ; null si le texte n'est pas une position relative. */
export function decodeRelPos(encoded: string): RelPosJSON | null {
  if (!/^[A-Za-z0-9+/]+=*$/.test(encoded)) return null
  try {
    const rp = Y_.relativePositionToJSON(Y_.decodeRelativePosition(base64ToBytes(encoded))) as RelPosJSON
    // Une vraie position designe un caractere, ou la fin d'un texte.
    return rp['item'] || rp['tname'] || rp['type'] ? rp : null
  } catch {
    return null
  }
}
