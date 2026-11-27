// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// plugin-app : le cadre d'une application, ses chemins, ses fichiers, ses outils.
import { describe, it, expect, vi } from 'vitest'
import type { PluginAPI, PluginTool, ToolContext } from '@savoire/plugin-api'
import {
  APP_CSP, AppHost, appAgentTools, appPathOf, buildAppDocument, normalizeAppPath, rewriteAppHtml, rewriteModuleImports,
} from '@savoire/plugin-app'

type Doc = { id: string; text: string; binary?: Uint8Array; v: number }

/** Un faux vault : des fichiers par chemin, ce que l'application et les outils utilisent. */
function world(files: Record<string, string> = {}) {
  const docs = new Map<string, Doc>()
  let n = 0
  for (const [p, text] of Object.entries(files)) docs.set(p, { id: `d${++n}`, text, v: 1 })
  const byId = (id: string) => [...docs.entries()].find(([, d]) => d.id === id)
  const trashed = new Set<string>()
  const vault = {
    getFileTree: () => [...docs.entries()].map(([path, d]) => ({ docId: d.id, path, crdtVersion: { v: d.v } })),
    resolveDocumentId: (p: string) => docs.get(p)?.id,
    read: async (id: string) => { const e = byId(id); if (!e || e[1].binary) throw new Error('binaire'); return e[1].text },
    readDocumentByPath: async (p: string) => { const d = docs.get(p); if (!d) throw new Error('introuvable'); if (d.binary) return new TextDecoder().decode(d.binary); return d.text },
    readBinary: async (p: string) => docs.get(p)?.binary ?? null,
    createFile: vi.fn(async (p: string) => { docs.set(p, { id: `d${++n}`, text: '', v: 1 }) }),
    createFolder: vi.fn(async () => {}),
    editText: vi.fn(async (id: string, fn: (s: string) => string) => { const e = byId(id)!; e[1].text = fn(e[1].text); e[1].v++; return true }),
    write: vi.fn(async () => {}),
    deleteFile: vi.fn(async (id: string) => { const e = byId(id)!; docs.delete(e[0]); docs.set(`.trash/${e[0]}`, e[1]); trashed.add(id) }),
    renameFile: vi.fn(async (id: string, to: string) => { const e = byId(id)!; docs.delete(e[0]); docs.set(to, e[1]) }),
    isTrashed: (id: string) => trashed.has(id),
    getCurrentUser: () => ({ id: 'u1', name: 'Camille' }),
  }
  const notify = vi.fn()
  const api = { vault, workspace: { notify, openFile: vi.fn() }, review: { propose: vi.fn(async () => 'p1') } } as unknown as PluginAPI
  return { api, docs, vault, notify }
}

/** Une application montee (srcdoc), et un faux code d'application qui lui parle. */
async function mount(api: PluginAPI, appPath = 'Histoire/Histoire.app', opts: { readOnly?: boolean; onWorkers?: (n: number) => void } = {}) {
  const host = new AppHost(api, { appPath, readOnly: !!opts.readOnly, onWorkers: opts.onWorkers })
  document.body.appendChild(host.frame)
  await host.loadApp('<div id="root"></div>', { react: 'export default {}' })
  const channel = /const ch="([0-9a-f]+)"/.exec(host.frame.srcdoc)![1]
  const win = host.frame.contentWindow!
  const replies: Record<string, unknown>[] = []
  vi.spyOn(win, 'postMessage').mockImplementation((m: unknown) => { replies.push(m as Record<string, unknown>) })
  const send = (data: Record<string, unknown>) =>
    window.dispatchEvent(new MessageEvent('message', { data: { ch: channel, ...data }, source: win as Window }))
  const tick = () => new Promise(r => setTimeout(r, 20))
  let next = 1000
  const call = async (fn: string, ...args: unknown[]) => {
    const id = ++next
    send({ t: 'call', id, fn, args })
    for (let i = 0; i < 50 && !replies.some(r => r.id === id); i++) await tick()
    return replies.find(r => r.id === id) as { ok: boolean; v?: unknown; e?: string }
  }
  return { host, call, send, replies, tick }
}

describe('application : chemins', () => {
  it('relatifs au dossier, sans en sortir ni viser la corbeille', () => {
    expect(normalizeAppPath('donnees/plans.json')).toBe('donnees/plans.json')
    expect(normalizeAppPath('./a/../b.json')).toBe('b.json')
    expect(() => normalizeAppPath('../secret.md')).toThrow(/hors du dossier/)
    expect(() => normalizeAppPath('a/../../x')).toThrow(/hors du dossier/)
    expect(() => normalizeAppPath('.trash/x')).toThrow(/corbeille/)
    expect(() => normalizeAppPath('')).toThrow(/vide/)
    expect(() => normalizeAppPath(3)).toThrow()
  })

  it('imports relatifs des modules -> app/<chemin> ; imports nus intacts', () => {
    const code = `import React from 'react'\nimport { a } from './a.js'\nexport { b } from "../b.js"\nimport './c.css.js'\nconst d = await import('./d.js')`
    const out = rewriteModuleImports('lib/x.js', code)
    expect(out).toContain(`from 'react'`)
    expect(out).toContain(`from 'app/lib/a.js'`)
    expect(out).toContain(`from "app/b.js"`)
    expect(out).toContain(`import 'app/lib/c.css.js'`)
    expect(out).toContain(`import('app/lib/d.js')`)
  })

  it('chemin d une application : dossier ou fichier .app', () => {
    expect(appPathOf('Histoire')).toBe('Histoire/Histoire.app')
    expect(appPathOf('Projets/Histoire')).toBe('Projets/Histoire.app')
    expect(appPathOf('/Histoire/Histoire.app')).toBe('Histoire/Histoire.app')
    expect(() => appPathOf('../x')).toThrow()
  })
})

describe('application : document du cadre', () => {
  it('politique sans reseau, modules et workers en blob:, pont et carte d import avant le code', () => {
    expect(APP_CSP).toContain("default-src 'none'")
    expect(APP_CSP).toContain("script-src 'unsafe-inline' blob:")
    expect(APP_CSP).toContain('worker-src blob:')
    expect(APP_CSP).not.toMatch(/https?:/)
    const doc = buildAppDocument({
      source: '<script type="module" src="main.js"></script><p>app</p>',
      files: { 'main.js': 'console.log("</script>")' },
      libraries: { react: 'export default 1' },
      channel: 'abc', readOnly: false, theme: '',
      app: { path: 'H/H.app', folder: 'H', name: 'H' }, user: null,
    })
    expect(doc.indexOf('Content-Security-Policy')).toBeLessThan(doc.indexOf('window.savoire'))
    expect(doc.indexOf('window.savoire')).toBeLessThan(doc.indexOf('importmap'))
    expect(doc.indexOf('importmap')).toBeLessThan(doc.indexOf('<p>app</p>'))
    expect(doc).toContain('<script type="module">import "app/main.js"</script>')
    // Le code des fichiers voyage en JSON sans pouvoir fermer sa balise.
    expect(doc).not.toContain('console.log("</script>")')
    expect(doc).toContain('\\u003c/script>')
  })

  it('HTML : script classique et feuille de style recopies, module en ligne aux imports reecrits', () => {
    const html = rewriteAppHtml(
      '<link rel="stylesheet" href="./style.css"><script src="app/vieux.js"></script><script type="module">import { go } from "./main.js"; go()</script><script src="inconnu.js"></script>',
      { 'style.css': 'p{color:red}', 'vieux.js': 'var x = "</script>"', 'main.js': '' },
    )
    expect(html).toContain('<style>p{color:red}</style>')
    expect(html).toContain('<script>var x = "<\\/script>"</script>')
    expect(html).toContain('from "app/main.js"')
    expect(html).toContain('<script src="inconnu.js"></script>')
  })
})

describe('application : fichiers de son dossier', () => {
  it('liste, lit, ecrit (cree au besoin), deplace, met a la corbeille ; rien hors du dossier', async () => {
    const w = world({ 'Histoire/Histoire.app': '<p/>', 'Histoire/donnees/a.json': '{"n":1}', 'Histoire/main.js': 'export {}', 'Autre/secret.md': 'x' })
    const { host, call } = await mount(w.api)
    const list = await call('files.list', '', true)
    expect(list.ok).toBe(true)
    expect((list.v as { path: string }[]).map(e => e.path)).toEqual(['donnees', 'donnees/a.json', 'Histoire.app', 'main.js'].sort((a, b) => a.localeCompare(b)))
    expect((await call('files.read', 'donnees/a.json')).v).toBe('{"n":1}')
    expect((await call('files.read', '../Autre/secret.md')).e).toMatch(/hors du dossier/)
    expect((await call('files.write', 'donnees/a.json', '{"n":2}')).ok).toBe(true)
    expect(w.docs.get('Histoire/donnees/a.json')!.text).toBe('{"n":2}')
    expect((await call('files.write', 'donnees/neuf/b.json', '[]')).ok).toBe(true)
    expect(w.vault.createFile).toHaveBeenCalledWith('Histoire/donnees/neuf/b.json')
    expect(w.docs.get('Histoire/donnees/neuf/b.json')!.text).toBe('[]')
    expect((await call('files.move', 'donnees/neuf/b.json', 'donnees/c.json')).ok).toBe(true)
    expect(w.docs.has('Histoire/donnees/c.json')).toBe(true)
    expect((await call('files.remove', 'donnees/c.json')).ok).toBe(true)
    expect((await call('files.read', 'donnees/c.json')).e).toMatch(/introuvable/)
    const bytes = await call('files.bytes', 'main.js')
    expect((bytes.v as { mime: string }).mime).toBe('text/javascript')
    host.dispose()
  })

  it('un module garde tel quel (envoye par add_file) part avec l application', async () => {
    const w = world({ 'H/H.app': '' })
    w.docs.set('H/lib/carte.js', { id: 'bin', text: '', binary: new TextEncoder().encode('export const carte = 42'), v: 1 })
    const { host } = await mount(w.api, 'H/H.app')
    expect(host.frame.srcdoc).toContain('export const carte = 42')
    expect(host.frame.srcdoc).toContain('lib/carte.js')
    host.dispose()
  })

  it('lecture seule, ou application a la racine du vault : aucune ecriture', async () => {
    const w = world({ 'H/H.app': '', 'H/a.json': '{}', 'R.app': '' })
    const ro = await mount(w.api, 'H/H.app', { readOnly: true })
    expect((await ro.call('files.write', 'a.json', '[]')).e).toMatch(/Lecture seule/)
    ro.host.dispose()
    const root = await mount(w.api, 'R.app')
    expect((await root.call('files.write', 'a.json', '[]')).e).toMatch(/racine du vault/)
    expect(root.host.frame.srcdoc).toContain('readOnly":true')
    root.host.dispose()
  })

  it('suivi du dossier : les changements d un autre arrivent au cadre', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const w = world({ 'H/H.app': '', 'H/a.json': '{}' })
      const { host, call, replies } = await mount(w.api, 'H/H.app')
      await call('files.watch')
      w.docs.get('H/a.json')!.v++
      w.docs.set('H/b.json', { id: 'z', text: '', v: 1 })
      w.docs.set('Ailleurs/c.json', { id: 'y', text: '', v: 1 })
      await vi.advanceTimersByTimeAsync(1600)
      const msg = replies.find(r => r.t === 'files') as { changes: { path: string; change: string }[] }
      expect(msg.changes).toEqual(expect.arrayContaining([{ path: 'a.json', change: 'changed' }, { path: 'b.json', change: 'added' }]))
      expect(msg.changes.some(c => c.path.includes('c.json'))).toBe(false)
      host.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('suivi : un fichier lu, modifie ailleurs sans que l arborescence le dise, est relu', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const w = world({ 'H/H.app': '', 'H/a.json': '{"n":1}' })
      const { host, call, replies } = await mount(w.api, 'H/H.app')
      await call('files.read', 'a.json')
      await call('files.watch')
      w.docs.get('H/a.json')!.text = '{"n":2}'
      await vi.advanceTimersByTimeAsync(3200)
      const msg = replies.find(r => r.t === 'files') as { changes: { path: string; change: string }[] }
      expect(msg.changes).toEqual([{ path: 'a.json', change: 'changed' }])
      // Nos propres ecritures ne reviennent pas comme des changements.
      replies.length = 0
      await call('files.write', 'a.json', '{"n":3}')
      w.docs.get('H/a.json')!.v--
      await vi.advanceTimersByTimeAsync(3200)
      expect(replies.some(r => r.t === 'files')).toBe(false)
      host.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('workers : le cadre les compte, Savoire peut les arreter', async () => {
    const w = world({ 'H/H.app': '' })
    const onWorkers = vi.fn()
    const { host, send, replies, tick } = await mount(w.api, 'H/H.app', { onWorkers })
    send({ t: 'workers', n: 2 })
    await tick()
    expect(onWorkers).toHaveBeenCalledWith(2)
    host.stopWorkers()
    expect(replies.some(r => r.t === 'stop-workers')).toBe(true)
    host.dispose()
  })
})

describe('application : outils d agent', () => {
  const ctx = (mode: 'direct' | 'propose' = 'direct') => ({ mode, actor: { agentName: 'Claude' } }) as unknown as ToolContext
  const tool = (api: PluginAPI, name: string) => appAgentTools(api).find(t => t.spec.name === name) as PluginTool

  it('app_create : dossier, .app et fichiers ; jamais a la racine ; app_list les voit', async () => {
    const w = world()
    const r = await tool(w.api, 'app_create').run({ path: 'Histoire', html: '<p/>', files: { 'main.js': 'export {}', 'donnees/a.json': '{}' } }, ctx())
    expect(r.text).toContain('Histoire/Histoire.app')
    expect(w.docs.get('Histoire/Histoire.app')!.text).toBe('<p/>')
    expect(w.docs.get('Histoire/donnees/a.json')!.text).toBe('{}')
    await expect(tool(w.api, 'app_create').run({ path: 'R.app', html: 'x' }, ctx())).rejects.toThrow(/racine/)
    await expect(tool(w.api, 'app_create').run({ path: 'Histoire', html: 'x' }, ctx())).rejects.toThrow(/existe déjà/)
    await expect(tool(w.api, 'app_create').run({ path: 'Autre', html: 'x', files: { '../x.md': '' } }, ctx())).rejects.toThrow(/hors du dossier/)
    expect((await tool(w.api, 'app_list').run({}, ctx())).text).toContain('Histoire/Histoire.app (2 fichier(s)')
  })

  it('app_write_file : cree, remplace un passage, ou propose selon les droits', async () => {
    const w = world({ 'H/H.app': '', 'H/main.js': 'const a = 1\nconst b = 2\n' })
    await tool(w.api, 'app_write_file').run({ app: 'H/H.app', file: 'main.js', find: 'const b = 2', replace: 'const b = 3' }, ctx())
    expect(w.docs.get('H/main.js')!.text).toBe('const a = 1\nconst b = 3\n')
    await tool(w.api, 'app_write_file').run({ app: 'H', file: 'donnees/x.json', content: '[]' }, ctx())
    expect(w.docs.get('H/donnees/x.json')!.text).toBe('[]')
    const p = await tool(w.api, 'app_write_file').run({ app: 'H', file: 'main.js', content: 'neuf' }, ctx('propose'))
    expect(p.text).toMatch(/proposée/)
    expect(w.docs.get('H/main.js')!.text).toBe('const a = 1\nconst b = 3\n')
    const read = await tool(w.api, 'app_read').run({ app: 'H', file: 'donnees/x.json' }, ctx())
    expect(read.text).toContain('- main.js')
    expect(read.text).toContain('[]')
    expect((await tool(w.api, 'app_guide').run({}, ctx())).text).toContain('savoire.files.read')
  })
})
