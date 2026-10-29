// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Erreurs du noyau d'indexation. Les codes sont ceux du protocole
// (docs/Architecture/indexer-protocol.md) : ceux de QueryErrorInfo, plus
// pouvoir ou methode inconnus. Le pair les traduit en reponses HTTP.
import type { QueryErrorInfo } from '@savoire/plugin-api'

export type IndexErrorCode = QueryErrorInfo['code'] | 'unknown_capability' | 'unknown_method'

export class IndexError extends Error {
  constructor(readonly code: IndexErrorCode, message: string) {
    super(message)
    this.name = 'IndexError'
  }

  toJSON(): { code: IndexErrorCode; message: string } {
    return { code: this.code, message: this.message }
  }
}

export function invalid(message: string): IndexError {
  return new IndexError('invalid_query', message)
}
