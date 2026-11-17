// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Un plugin du store dans la page, dans un VRAI navigateur (Chromium) : le
// code est evalue depuis une adresse blob:, recoit l'API filtree par ses
// droits, et la CSP de l'appli (script-src ... blob:) le laisse tourner.
//
// Sans Chromium installe (npx playwright install chromium), ces tests sont passes.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createRequire } from 'node:module'
import { existsSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const here = path.dirname(new URL(import.meta.url).pathname)
const repo = path.resolve(here, '../../../../..')
const fromFrontend = createRequire(path.join(repo, 'frontend/package.json'))

type Page = { evaluate<T>(fn: string): Promise<T>; addScriptTag(o: { content: string }): Promise<unknown>; setContent(html: string): Promise<void> }
type Browser = { newPage(): Promise<Page>; close(): Promise<void> }
type Chromium = { launch(): Promise<Browser>; executablePath(): string }
function findChromium(): Chromium | null {
  try {
    const c = (fromFrontend('@playwright/test') as { chromium: Chromium }).chromium
    return existsSync(c.executablePath()) ? c : null
  } catch { return null }
}
const chromium = findChromium()

/** storePlugin (plugin-runtime) en un seul script, pose dans la page sous window.R. */
async function bundle(): Promise<string> {
  const viaVitest = createRequire(fromFrontend.resolve('vitest'))
  const esbuild = createRequire(viaVitest.resolve('vite'))('esbuild') as {
    build(o: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }>
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'store-plugin-'))
  const entry = path.join(dir, 'entry.ts')
  writeFileSync(entry, `export { storePlugin } from ${JSON.stringify(path.join(repo, 'packages/plugin-runtime/src/StorePlugin.ts'))}\n`)
  const out = await esbuild.build({
    entryPoints: [entry], bundle: true, format: 'iife', globalName: 'R', write: false, platform: 'browser', logLevel: 'silent',
    alias: {
      '@savoire/plugin-api': path.join(repo, 'packages/plugin-api/src/index.ts'),
      '@savoire/domain-index': path.join(repo, 'packages/domain-index/src/index.ts'),
    },
  })
  return out.outputFiles[0].text
}

const CODE = `module.exports = {
  onload(api) {
    api.views.register({ id: 'kanban', title: 'Kanban' })
    window.__ok = 'charge'
    try { api.query; window.__query = 'lu' } catch (e) { window.__query = 'refuse' }
  },
  onunload() { window.__ok = 'decharge' },
}`

const run = (page: Page) => page.evaluate<{ ok: string; query: string; views: number; error: string }>(`(async () => {
  const pkg = { format: 1, id: 'kanban', kind: 'plugin', version: '1.0.0',
    manifest: { id: 'kanban', name: 'Kanban', version: '1.0.0', permissions: ['ui:editor'] },
    files: { 'main.js': ${JSON.stringify(CODE)} } }
  const views = []
  const api = { views: { register: v => views.push(v) }, query: {} }
  let error = ''
  try { const p = R.storePlugin(pkg); await p.onload(api); await p.onunload() } catch (e) { error = String(e && e.message || e) }
  return { ok: window.__ok, query: window.__query, views: views.length, error }
})()`)

describe.skipIf(!chromium)('plugin du store dans la page (Chromium)', () => {
  let browser: Browser
  let code: string
  beforeAll(async () => { browser = await chromium!.launch(); code = await bundle() }, 60_000)
  afterAll(async () => { await browser?.close() })

  const pageWith = async (scriptSrc: string) => {
    const page = await browser.newPage()
    await page.setContent(`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="script-src ${scriptSrc}"></head><body></body></html>`)
    await page.addScriptTag({ content: code })
    return page
  }

  it('avec la CSP de l appli (blob: permis) : charge, droits filtres, dechargeable', async () => {
    const r = await run(await pageWith("'unsafe-inline' blob:"))
    expect(r.error).toBe('')
    expect(r.views).toBe(1)
    expect(r.query).toBe('refuse')
    expect(r.ok).toBe('decharge')
  })

  it('temoin : sans blob: dans la CSP, le plugin ne se charge pas', async () => {
    const r = await run(await pageWith("'unsafe-inline'"))
    expect(r.error).not.toBe('')
    expect(r.views).toBe(0)
  })
})
