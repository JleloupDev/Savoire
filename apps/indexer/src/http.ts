// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Outils HTTP : jeton de service compare en temps constant, corps borne,
// reponses JSON et erreurs du protocole.
import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { HttpError, errorBody } from './errors'

/** Compare le jeton recu a celui attendu, en temps constant (empreintes de meme taille). */
export function tokenMatches(header: string | undefined, expected: string): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? '')
  const got = createHash('sha256').update(m?.[1]?.trim() ?? '').digest()
  const want = createHash('sha256').update(expected).digest()
  return timingSafeEqual(got, want) && !!m
}

/** Lit le corps (au plus max octets ; au-dela, 413). */
export function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers['content-length'] ?? NaN)
    if (Number.isFinite(len) && len > max) {
      reject(new HttpError(413, 'payload_too_large', `Corps de plus de ${max} octets.`))
      req.resume()
      return
    }
    const chunks: Buffer[] = []
    let total = 0
    let done = false
    req.on('data', (c: Buffer) => {
      if (done) return
      total += c.length
      if (total > max) {
        done = true
        reject(new HttpError(413, 'payload_too_large', `Corps de plus de ${max} octets.`))
        req.resume()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks, total)) } })
    req.on('error', err => { if (!done) { done = true; reject(err) } })
  })
}

export function parseJson(body: Buffer): unknown {
  if (!body.length) return {}
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    throw new HttpError(400, 'invalid_query', 'Corps : JSON invalide.')
  }
}

export function sendJson(res: ServerResponse, status: number, json: string, headers: Record<string, string> = {}): void {
  if (res.headersSent || res.destroyed) return
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(json)
}

export function sendError(res: ServerResponse, err: HttpError): void {
  sendJson(res, err.status, errorBody(err.code, err.message), err.retryAfter !== undefined ? { 'retry-after': String(err.retryAfter) } : {})
}

export function sendText(res: ServerResponse, status: number, text: string, contentType: string): void {
  if (res.headersSent || res.destroyed) return
  res.writeHead(status, { 'content-type': contentType, 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' })
  res.end(text)
}
