// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Cote Savoire d'un plugin tiers : happy-dom n'execute pas le code de
// l'iframe ; on joue ses messages a sa place.
import { describe, it, expect, vi } from 'vitest'
import type { ExtractorSpec, PluginAPI } from '@savoire/plugin-api'
import { FramedPlugin, buildPluginSrcdoc, framedPluginCsp } from '@savoire/plugin-runtime'

function fakeApi() {
  const commands = new Map<string, { run: (ctx: unknown) => void }>()
  const extractors: ExtractorSpec[] = []
  const files = new Map<string, string>([['a.md', '# A']])
  const api = {
    commands: { register: vi.fn((c: { id: string; run: (ctx: unknown) => void }) => commands.set(c.id, c)), unregister: vi.fn((id: string) => commands.delete(id)) },
    extractors: {
      register: vi.fn((s: ExtractorSpec) => { extractors.push(s); return () => extractors.splice(extractors.indexOf(s), 1) }),
      forPath: () => undefined, list: () => extractors, onChange: () => () => {},
    },
    vault: {
      list: vi.fn(async () => [...files.keys()]),
      read: vi.fn(async (id: string) => files.get(id) ?? ''),
      readDocumentByPath: vi.fn(async (p: string) => files.get(p) ?? ''),
      resolveDocumentId: (p: string) => (files.has(p) ? p : undefined),
      write: vi.fn(async (id: string, t: string) => { files.set(id, t) }),
      createFile: vi.fn(async (p: string) => { files.set(p, '') }),
    },
    workspace: { openFile: vi.fn(async () => {}) },
  }
  return { api: api as unknown as PluginAPI, raw: api, commands, extractors, files }
}

/** Le plugin dans son iframe : envoie un message comme lui, recoit ce que Savoire lui poste. */
function harness(permissions: string[]) {
  const f = fakeApi()
  const plugin = new FramedPlugin({ id: 'demo', name: 'Démo', code: 'module.exports={onload(){}}', permissions, api: f.api })
  const started = plugin.start()
  const win = plugin.frame.contentWindow as Window
  const ch = /const ch="([0-9a-f]+)"/.exec(plugin.frame.srcdoc)![1]
  const received: Record<string, unknown>[] = []
  const send = (m: Record<string, unknown>) => window.dispatchEvent(new MessageEvent('message', { data: { ch, ...m }, source: win }))
  vi.spyOn(win, 'postMessage').mockImplementation((m: unknown) => {
    received.push(m as Record<string, unknown>)
    if ((m as { t?: string }).t === 'unload') setTimeout(() => send({ t: 'unloaded' }), 0)
  })
  const answer = async (id: number) => {
    for (let i = 0; i < 50; i++) {
      const r = received.find(x => x.t === 'res' && x.id === id)
      if (r) return r
      await new Promise(res => setTimeout(res, 1))
    }
    throw new Error('pas de reponse')
  }
  return { plugin, started, send, answer, received, ...f }
}

describe('buildPluginSrcdoc', () => {
  it('pose la CSP avant le code, et neutralise </script> dans le code', () => {
    const html = buildPluginSrcdoc('const s = "</script><img src=x>"', { channel: 'c', network: false })
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('const s'))
    expect(html).not.toContain('"</script><img')
    expect(html).toContain("connect-src 'none'")
  })

  it('ouvre https seulement avec un droit reseau', () => {
    expect(framedPluginCsp(true)).toContain('connect-src https:')
    expect(framedPluginCsp(false)).not.toContain('https:')
  })
})

describe('FramedPlugin', () => {
  it('isole le plugin : iframe sandbox sans meme origine', async () => {
    const h = harness([])
    expect(h.plugin.frame.getAttribute('sandbox')).toBe('allow-scripts')
    h.send({ t: 'ready' })
    await h.started
    await h.plugin.stop()
  })

  it('refuse ce que ses droits ne permettent pas', async () => {
    const h = harness(['vault:read'])
    h.send({ t: 'ready' })
    await h.started
    h.send({ t: 'call', id: 1, fn: 'vault.read', args: ['a.md'] })
    expect(await h.answer(1)).toMatchObject({ ok: true, v: '# A' })
    h.send({ t: 'call', id: 2, fn: 'vault.write', args: ['a.md', 'pirate'] })
    expect(await h.answer(2)).toMatchObject({ ok: false })
    expect(h.files.get('a.md')).toBe('# A')
    h.send({ t: 'call', id: 3, fn: 'commands.register', args: [{ id: 'x', name: 'X' }] })
    expect(await h.answer(3)).toMatchObject({ ok: false })
    h.send({ t: 'call', id: 4, fn: 'vault.read', args: ['../secret'] })
    expect(await h.answer(4)).toMatchObject({ ok: false })
    await h.plugin.stop()
  })

  it('ignore les messages d une autre fenetre ou d un autre canal', async () => {
    const h = harness(['vault:write'])
    h.send({ t: 'ready' })
    await h.started
    window.dispatchEvent(new MessageEvent('message', { data: { ch: 'autre', t: 'call', id: 9, fn: 'vault.write', args: ['a.md', 'x'] }, source: h.plugin.frame.contentWindow }))
    window.dispatchEvent(new MessageEvent('message', { data: { t: 'call', id: 9, fn: 'vault.write', args: ['a.md', 'x'] }, source: window }))
    await new Promise(r => setTimeout(r, 5))
    expect(h.files.get('a.md')).toBe('# A')
    await h.plugin.stop()
  })

  it('ses commandes sont prefixees, executees dans l iframe, retirees a l arret', async () => {
    const h = harness(['ui:editor'])
    h.send({ t: 'ready' })
    await h.started
    h.send({ t: 'call', id: 1, fn: 'commands.register', args: [{ id: 'hello', name: 'Bonjour' }] })
    expect(await h.answer(1)).toMatchObject({ ok: true, v: 'demo:hello' })
    const cmd = h.commands.get('demo:hello')!
    expect((cmd as unknown as { label: string }).label).toBe('Démo : Bonjour')
    cmd.run({})
    expect(h.received.find(m => m.t === 'run')).toMatchObject({ kind: 'command', key: 'hello' })
    await h.plugin.stop()
    expect(h.raw.commands.unregister).toHaveBeenCalledWith('demo:hello')
  })

  it('ses extracteurs ne sont jamais officiels, et leur resultat est verifie', async () => {
    const h = harness([])
    h.send({ t: 'ready' })
    await h.started
    h.send({ t: 'call', id: 1, fn: 'extractors.register', args: [{ id: 'log', label: 'Journaux', extensions: ['.LOG'] }] })
    expect(await h.answer(1)).toMatchObject({ ok: true })
    const spec = h.extractors[0]
    expect(spec).toMatchObject({ id: 'demo:log', extensions: ['log'], official: false })
    const out = spec.extract(new Uint8Array([104, 105]), { path: 'x.log' })
    await new Promise(r => setTimeout(r, 1))
    const run = h.received.find(m => m.t === 'run')!
    expect(run).toMatchObject({ kind: 'extract', key: 'log', info: { path: 'x.log' } })
    h.send({ t: 'done', id: run.id, ok: true, v: { sections: [{ text: 'hi', extra: 1 }], props: { evil: 1 } } })
    expect(await out).toEqual({ title: undefined, sections: [{ heading: undefined, text: 'hi' }] })
    await h.plugin.stop()
    expect(h.extractors).toHaveLength(0)
  })

  it('un onload en echec fait echouer le demarrage et retire l iframe', async () => {
    const h = harness([])
    h.send({ t: 'failed', e: 'boum' })
    await expect(h.started).rejects.toThrow(/boum/)
    expect(h.plugin.frame.isConnected).toBe(false)
  })
})
