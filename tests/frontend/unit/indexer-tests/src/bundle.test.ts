// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le paquet construit (dist/indexer.mjs, esbuild) lance comme en production :
// deux fils d'indexation (worker_threads), journal JSON, arret sur SIGTERM,
// et arret brutal (SIGKILL) suivi d'une reprise sans reconstruction.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { FakeBackend } from './fakeBackend'
import { TOKEN, tempDir, testEnv, until } from './harness'

const APP = join(__dirname, '../../../../../apps/indexer')
const BUNDLE = join(APP, 'dist/indexer.mjs')

let backend: FakeBackend
let tmp: { dir: string; cleanup: () => void }

beforeAll(async () => {
  execFileSync(process.execPath, [join(APP, 'build.mjs')], { stdio: 'pipe' })
  backend = await new FakeBackend({ token: TOKEN }).start()
  tmp = tempDir()
})

afterAll(async () => {
  await backend.stop()
  tmp.cleanup()
})

function launch(port: number): { child: ChildProcess; lines: string[]; exited: Promise<number | null> } {
  const env = testEnv(backend, tmp.dir, { SAVOIRE_INDEXER_WORKERS: '2', SAVOIRE_INDEXER_PORT: String(port), SAVOIRE_INDEXER_LOG_LEVEL: 'info' })
  const child = spawn(process.execPath, [BUNDLE], { env: { PATH: process.env['PATH'] ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  const lines: string[] = []
  child.stdout!.on('data', (b: Buffer) => lines.push(...b.toString().split('\n').filter(Boolean)))
  child.stderr!.on('data', (b: Buffer) => lines.push(...b.toString().split('\n').filter(Boolean)))
  const exited = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)))
  return { child, lines, exited }
}

async function call(port: number, vaultId: string, text: string): Promise<string[]> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/vaults/${vaultId}/call`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ capability: 'search', method: 'run', params: { text }, caller: { userId: 'u' } }),
  })
  if (res.status !== 200) return []
  return ((await res.json()) as { result: { hits: { id: string }[] } }).result.hits.map(h => h.id).sort()
}

describe('paquet construit, deux fils', () => {
  it('indexe, repond, s arrete proprement ; apres un arret brutal, reprend sans reconstruire', async () => {
    for (const v of ['va', 'vb', 'vc', 'vd']) for (let i = 0; i < 10; i++) backend.writeNote(v, `${v}-${i}`, `N${i}.md`, `note ${i} du vault ${v} commune`)
    const port = 17000 + Math.floor(Math.random() * 2000)
    let run = launch(port)
    try {
      await until(async () => (await Promise.all(['va', 'vb', 'vc', 'vd'].map(v => call(port, v, 'commune')))).every(h => h.length === 10), 20_000, 'construction')
      // Les vaults sont repartis sur les deux fils.
      const metrics = await (await fetch(`http://127.0.0.1:${port}/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } })).text()
      expect(metrics).toMatch(/savoire_indexer_open_files\{shard="0"\} [1-9]/)
      expect(metrics).toMatch(/savoire_indexer_open_files\{shard="1"\} [1-9]/)
      backend.writeNote('va', 'va-new', 'Neuve.md', 'neuve dans va')
      await until(async () => (await call(port, 'va', 'neuve')).length === 1, 5000, 'note neuve')
      // Journal : une ligne JSON par evenement.
      expect(run.lines.every(l => { try { JSON.parse(l); return true } catch { return false } })).toBe(true)
      expect(run.lines.some(l => l.includes('"pair indexeur demarre"'))).toBe(true)

      run.child.kill('SIGTERM')
      expect(await run.exited).toBe(0)
      expect(run.lines.some(l => l.includes('"pair indexeur arrete"'))).toBe(true)

      // Arret brutal pendant que le flux bouge.
      run = launch(port)
      await until(async () => (await call(port, 'vb', 'commune')).length === 10, 10_000, 'redemarrage')
      backend.writeNote('vb', 'vb-x', 'X.md', 'ecrite avant le crash')
      await until(async () => (await call(port, 'vb', 'crash')).length === 1, 5000, 'avant crash')
      await new Promise(r => setTimeout(r, 1200))
      run.child.kill('SIGKILL')
      await run.exited
      backend.writeNote('vc', 'vc-y', 'Y.md', 'ecrite pendant la panne')

      run = launch(port)
      await until(async () => (await call(port, 'vc', 'panne')).length === 1, 10_000, 'reprise')
      const m2 = await (await fetch(`http://127.0.0.1:${port}/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } })).text()
      expect(m2).not.toMatch(/savoire_indexer_builds_total\{[^}]*result="ok"[^}]*\} [1-9]/)
      expect(await call(port, 'vb', 'crash')).toEqual(['vb-x'])
    } finally {
      run.child.kill('SIGTERM')
      await run.exited
    }
  }, 90_000)
})
