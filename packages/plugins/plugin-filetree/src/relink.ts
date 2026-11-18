// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Apres un deplacement ou un renommage (image, note, dossier) : les liens
// des notes suivent. Le code est celui du canal commun des deplacements
// (plugin-api/relink.ts), partage avec les bases et les agents (dans l'appli
// et sur le pair indexeur du serveur) : ici, seulement le branchement sur
// l'index du vault (links.citing).
import type { IIndexerAPI, VaultAPI } from '@savoire/plugin-api'
import { relinkAfterMoves as relink, type Move } from '@savoire/plugin-api'

export type { Move }

/**
 * Recrit les liens des notes vers les fichiers deplaces. Rend le nombre de
 * notes modifiees. A appeler APRES les deplacements.
 */
export function relinkAfterMoves(
  vault: Pick<VaultAPI, 'list' | 'readDocumentByPath' | 'resolveDocumentId' | 'editText'>,
  moves: readonly Move[],
  indexer?: IIndexerAPI,
): Promise<number> {
  const citing = indexer?.available() && typeof indexer.links.citing === 'function'
    ? (names: string[]) => indexer.links.citing!({ names }).then(r => r.items)
    : undefined
  return relink(vault, moves, citing)
}
