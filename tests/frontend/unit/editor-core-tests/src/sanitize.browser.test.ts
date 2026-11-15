// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le nettoyage du HTML des notes, dans un VRAI navigateur (Chromium) : c'est
// la que DOMPurify sert, et la qu'un script s'executerait. Chaque charge est
// inseree dans une page ; rien ne doit s'y executer (revue du 14/11/2026, C2).
//
// Sans Chromium installe (npx playwright install chromium), ces tests sont
// passes : sanitize.dom.test.ts couvre alors le nettoyage strict seulement.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import path from 'node:path'

const here = path.dirname(new URL(import.meta.url).pathname)
const repo = path.resolve(here, '../../../../..')
const fromFrontend = createRequire(path.join(repo, 'frontend/package.json'))

type Page = { evaluate<T>(fn: string | ((arg: never) => T), arg?: unknown): Promise<T>; addScriptTag(o: { content: string }): Promise<unknown>; setContent(html: string): Promise<void>; waitForTimeout(ms: number): Promise<void>; click(sel: string): Promise<void> }
type Browser = { newPage(): Promise<Page>; close(): Promise<void> }

type Chromium = { launch(): Promise<Browser>; executablePath(): string }
function findChromium(): Chromium | null {
  try {
    const c = (fromFrontend('@playwright/test') as { chromium: Chromium }).chromium
    return existsSync(c.executablePath()) ? c : null
  } catch { return null }
}
const chromium = findChromium()
const available = chromium !== null

/** sanitize.ts et DOMPurify en un seul script, pose dans la page sous window.S. */
async function bundle(): Promise<string> {
  const viaVitest = createRequire(fromFrontend.resolve('vitest'))
  const esbuild = createRequire(viaVitest.resolve('vite'))('esbuild') as {
    build(o: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }>
  }
  const out = await esbuild.build({
    entryPoints: [path.join(repo, 'packages/plugin-api/src/sanitize.ts')],
    bundle: true, format: 'iife', globalName: 'S', write: false, platform: 'browser', logLevel: 'silent',
  })
  return out.outputFiles[0].text
}

const PAYLOADS: [string, string][] = [
  ['image piegee', '<img src=x onerror="window.__xss=1">'],
  ['script', '<script>window.__xss=1</script>'],
  ['script apres du texte', '<p>ok</p><script>window.__xss=1</script>'],
  ['svg', '<svg onload="window.__xss=1"><script>window.__xss=1</script></svg>'],
  ['svg anime', '<svg><animate onbegin="window.__xss=1" attributeName="x" dur="1s"></svg>'],
  ['details', '<details open ontoggle="window.__xss=1">x</details>'],
  ['video', '<video src=x onerror="window.__xss=1"></video><audio src=x onerror="window.__xss=1"></audio>'],
  ['cadre', '<iframe srcdoc="<script>parent.__xss=1</script>"></iframe>'],
  ['cadre javascript', '<iframe src="javascript:parent.__xss=1"></iframe>'],
  ['objet', '<object data="javascript:window.__xss=1"></object><embed src="javascript:window.__xss=1">'],
  ['attribut casse', '<div title="a"onmouseover="window.__xss=1" style="position:fixed;inset:0">x</div>'],
  ['math', '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src=1 onerror=window.__xss=1&gt;">'],
  ['noscript', '<noscript><p title="</noscript><img src=x onerror=window.__xss=1>">'],
  ['style', '<style>@import "javascript:window.__xss=1";</style><style onload="window.__xss=1"></style>'],
  ['meta', '<meta http-equiv="refresh" content="0;url=javascript:window.__xss=1">'],
  ['champ autofocus', '<input autofocus onfocus="window.__xss=1"><select autofocus onfocus="window.__xss=1"></select>'],
  ['base', '<base href="javascript:window.__xss=1//"><a href="#x">a</a>'],
]

describe.skipIf(!available)('sanitizeHtml dans Chromium', () => {
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    browser = await chromium!.launch()
    page = await browser.newPage()
    await page.setContent('<!doctype html><html><body><div id="host"></div></body></html>')
    await page.addScriptTag({ content: await bundle() })
  }, 60_000)

  afterAll(async () => { await browser?.close() })

  /** Insere le HTML nettoye dans la page, comme l'application, et dit ce qui s'est passe. */
  const insert = (html: string) => page.evaluate(`(async () => {
    window.__xss = 0
    const host = document.getElementById('host')
    host.innerHTML = S.sanitizeHtml(${JSON.stringify(html)})
    await new Promise(r => setTimeout(r, 150))
    const all = [...host.querySelectorAll('*')]
    return {
      xss: window.__xss,
      html: host.innerHTML,
      handlers: all.some(el => el.getAttributeNames().some(n => n.toLowerCase().startsWith('on'))),
      tags: all.map(el => el.tagName.toLowerCase()),
    }
  })()`) as Promise<{ xss: number; html: string; handlers: boolean; tags: string[] }>

  it('c est bien DOMPurify qui sert dans un navigateur', async () => {
    expect(await page.evaluate('S.sanitizerKind()')).toBe('dompurify')
  })

  it('temoin : sans nettoyage, la meme page execute bien la charge', async () => {
    const ran = await page.evaluate(`(async () => {
      window.__xss = 0
      document.getElementById('host').innerHTML = '<img src=x onerror="window.__xss=1">'
      await new Promise(r => setTimeout(r, 150))
      return window.__xss
    })()`)
    expect(ran).toBe(1)
  })

  it.each(PAYLOADS)('rien ne s execute : %s', async (_name, payload) => {
    const r = await insert(payload)
    expect(r.xss, r.html).toBe(0)
    expect(r.handlers, r.html).toBe(false)
    for (const tag of ['script', 'iframe', 'object', 'embed', 'style', 'meta', 'base', 'form', 'select', 'textarea', 'button']) {
      expect(r.tags, r.html).not.toContain(tag)
    }
  })

  it('un clic sur un lien javascript: n execute rien', async () => {
    const r = await insert('<a id="l1" href="javascript:window.__xss=1">a</a><a id="l2" href=" JaVa\tScRiPt:window.__xss=1">b</a><a id="l3" href="data:text/html,<script>parent.__xss=1</script>">c</a>')
    expect(r.html.toLowerCase()).not.toMatch(/javascript|data:text/)
    for (const id of ['l1', 'l2']) await page.click('#' + id)
    await page.waitForTimeout(100)
    expect(await page.evaluate('window.__xss')).toBe(0)
  })

  it('pas de champ de saisie, sauf les cases a cocher', async () => {
    const r = await insert('<input type="password" name="p"><input type="text"><input type="checkbox" checked disabled name="n" value="v">')
    expect(r.tags).toEqual(['input'])
    expect(r.html).toContain('checkbox')
    expect(r.html).not.toMatch(/name=|value=/)
  })

  it('un lien vers un autre onglet ne garde pas la main sur la page', async () => {
    const r = await insert('<a href="https://exemple.org" target="_blank">x</a>')
    expect(r.html).toContain('target="_blank"')
    expect(r.html).toContain('noopener')
  })

  it('le HTML utile reste', async () => {
    const r = await insert('<h2>Titre</h2><p style="color:red">rouge<br>suite</p><mark class="plume-hl">s</mark>'
      + '<span class="plume-color" data-x="1">c</span><details><summary>T</summary>C</details>'
      + '<table><tbody><tr><td>1</td></tr></tbody></table><img src="https://exemple.org/a.png" alt="i" width="40">'
      + '<a href="#Ma note#Titre">interne</a><ul><li><input type="checkbox" checked disabled> fait</li></ul>')
    for (const tag of ['h2', 'p', 'br', 'mark', 'span', 'details', 'summary', 'table', 'td', 'img', 'a', 'ul', 'li', 'input']) {
      expect(r.tags, tag).toContain(tag)
    }
    expect(r.html).toContain('style="color:red"')
    expect(r.html).toContain('data-x="1"')
    expect(r.html).toContain('href="#Ma note#Titre"')
  })
})
