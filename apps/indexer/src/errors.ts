// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Erreurs rendues par le pair, exactement comme le protocole
// (docs/Architecture/indexer-protocol.md, « API du pair ») : corps
// { error: { code, message } }, Retry-After pour 429 et 503.
//
// Elles traversent la frontiere des fils d'execution : on les transporte en
// objets simples (WireError) et on les reconstruit de l'autre cote.

export interface WireError {
  status: number
  code: string
  message: string
  retryAfter?: number
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message)
    this.name = 'HttpError'
  }

  toWire(): WireError {
    return { status: this.status, code: this.code, message: this.message, ...(this.retryAfter !== undefined ? { retryAfter: this.retryAfter } : {}) }
  }

  static fromWire(w: WireError): HttpError {
    return new HttpError(w.status, w.code, w.message, w.retryAfter)
  }
}

/** Codes d'IndexError (indexer-core) -> statut HTTP. */
const INDEX_STATUS: Record<string, number> = {
  invalid_query: 400,
  invalid_cursor: 400,
  too_complex: 400,
  unknown_capability: 404,
  unknown_method: 404,
  unavailable: 503,
}

export function notOwner(vaultId: string): HttpError {
  return new HttpError(409, 'not_owner', `Le vault ${vaultId} n'appartient pas a cette instance.`)
}

export function overloaded(retryAfter: number): HttpError {
  return new HttpError(429, 'overloaded', 'File d\'attente pleine, reessayer.', retryAfter)
}

export function unavailable(message: string, retryAfter: number): HttpError {
  return new HttpError(503, 'unavailable', message, retryAfter)
}

/** Une erreur quelconque -> WireError. Les erreurs inattendues deviennent 500 `internal`. */
export function toWire(err: unknown, retryAfter: number): WireError {
  if (err instanceof HttpError) return err.toWire()
  const e = err as { name?: unknown; code?: unknown; message?: unknown }
  if (e && e.name === 'IndexError' && typeof e.code === 'string' && INDEX_STATUS[e.code]) {
    const status = INDEX_STATUS[e.code]!
    return { status, code: e.code, message: String(e.message ?? ''), ...(status === 503 ? { retryAfter } : {}) }
  }
  return { status: 500, code: 'internal', message: 'Erreur interne du pair indexeur.' }
}

export function errorBody(code: string, message: string): string {
  return JSON.stringify({ error: { code, message } })
}
