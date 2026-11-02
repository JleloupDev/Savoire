// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Outils des tests : un pair indexeur (dans le fil principal, WORKERS=0)
// branche sur le faux backend, avec des delais courts.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IndexPower } from '@savoire/indexer-core'
import { loadConfig } from '../../../../../apps/indexer/src/config'
import { createLogger } from '../../../../../apps/indexer/src/log'
import { IndexerService } from '../../../../../apps/indexer/src/service'
import type { FakeBackend } from './fakeBackend'

export const TOKEN = 'jeton-de-test-0123456789abcdef'

export function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'savoire-indexer-test-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

export function testEnv(backend: FakeBackend, dataDir: string, env: Record<string, string> = {}): Record<string, string> {
  return {
    SAVOIRE_INDEXER_NAME: 'idx-a',
    SAVOIRE_INDEXER_TOKEN: TOKEN,
    SAVOIRE_INDEXER_BACKEND_URL: backend.url,
    SAVOIRE_INDEXER_DATA_DIR: dataDir,
    SAVOIRE_INDEXER_HOST: '127.0.0.1',
    SAVOIRE_INDEXER_PORT: '0',
    SAVOIRE_INDEXER_WORKERS: '0',
    SAVOIRE_INDEXER_DEBOUNCE_MS: '40',
    SAVOIRE_INDEXER_DEBOUNCE_MAX_MS: '400',
    SAVOIRE_INDEXER_FEED_ACTIVE_MS: '10',
    SAVOIRE_INDEXER_FEED_IDLE_MS: '30',
    SAVOIRE_INDEXER_FEED_STALE_MS: '3000',
    SAVOIRE_INDEXER_VAULTS_REFRESH_MS: '60000',
    SAVOIRE_INDEXER_BACKEND_RETRIES: '0',
    SAVOIRE_INDEXER_BACKEND_TIMEOUT_MS: '3000',
    SAVOIRE_INDEXER_CALL_TIMEOUT_MS: '3000',
    SAVOIRE_INDEXER_LOG_LEVEL: process.env['INDEXER_TEST_LOG'] ?? 'silent',
    ...env,
  }
}

export interface Reply<T = unknown> {
  status: number
  body: T
  headers: Headers
}

export class Peer {
  constructor(readonly service: IndexerService) {}

  get url(): string {
    return `http://127.0.0.1:${this.service.port}`
  }

  async request<T = unknown>(method: string, path: string, body?: unknown, token: string | null = TOKEN): Promise<Reply<T>> {
    const res = await fetch(this.url + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    })
    const text = await res.text()
    let parsed: unknown = text
    try { parsed = JSON.parse(text) } catch { /* texte (metriques) */ }
    return { status: res.status, body: parsed as T, headers: res.headers }
  }

  call<T = unknown>(vaultId: string, capability: string, method: string, params: unknown = {}): Promise<Reply<{ result: T; error?: { code: string; message: string } }>> {
    return this.request('POST', `/v1/vaults/${encodeURIComponent(vaultId)}/call`, { capability, method, params, caller: { userId: 'u1' } })
  }

  /** Ids des notes trouvees par la recherche. */
  async found(vaultId: string, text: string): Promise<string[]> {
    const r = await this.call<{ hits: { id: string }[] }>(vaultId, 'search', 'run', { text })
    return r.status === 200 ? r.body.result.hits.map(h => h.id).sort() : []
  }

  status(vaultId: string): Promise<Reply<{ status: string; progress?: number; seq: number; docs: number; bytes: number }>> {
    return this.request('GET', `/v1/vaults/${encodeURIComponent(vaultId)}/status`)
  }

  async metrics(): Promise<string> {
    return (await this.request<string>('GET', '/metrics')).body
  }

  /** Valeur d'une metrique (somme des echantillons dont les etiquettes contiennent `labels`). */
  async metric(name: string, labels: Record<string, string> = {}): Promise<number> {
    const text = await this.metrics()
    let sum = 0
    for (const line of text.split('\n')) {
      if (!line.startsWith(name + '{') && !line.startsWith(name + ' ')) continue
      if (!Object.entries(labels).every(([k, v]) => line.includes(`${k}="${v}"`))) continue
      sum += Number(line.slice(line.lastIndexOf(' ') + 1))
    }
    return sum
  }

  stop(): Promise<void> {
    return this.service.stop('fin du test')
  }
}

export async function startPeer(backend: FakeBackend, dataDir: string, env: Record<string, string> = {}, powers?: () => IndexPower[]): Promise<Peer> {
  const { config } = loadConfig(testEnv(backend, dataDir, env))
  const log = createLogger(config.logLevel, { svc: 'test' })
  const service = new IndexerService({ config, log, version: 'test', ...(powers ? { powers } : {}) })
  await service.start()
  return new Peer(service)
}

/** Attend qu'une condition soit vraie (ou echoue au bout du delai). */
export async function until<T>(fn: () => Promise<T> | T, timeoutMs = 10_000, what = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  for (;;) {
    try {
      const v = await fn()
      if (v) return v
      last = v
    } catch (err) {
      last = err
    }
    if (Date.now() > deadline) throw new Error(`delai depasse : ${what} (dernier : ${last instanceof Error ? last.message : JSON.stringify(last)})`)
    await new Promise(r => setTimeout(r, 20))
  }
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
