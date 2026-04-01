// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, beforeAll } from 'vitest'
import plugin from '@savoire/plugin-module'
import type { BlockSpec, PluginAPI } from '@savoire/plugin-api'

type StrHook = (s: string) => string | Promise<string>
const hooks: StrHook[] = []
const commands: string[] = []
const specs: BlockSpec[] = []

const VAULT: Record<string, string> = {
  'modules/goals.md': `---\ntype: module\n---\n## Goals\n\nEditable content.\n`,
  'modules/plain.md': `## Plain\n\nNo frontmatter.\n`,
}

const stubAPI = {
  blocks: {
    register: (s: BlockSpec) => { specs.push(s) },
    unregister: () => {}, detectBlock: () => null, getAll: () => [],
  },
  hooks: {
    beforeParse: (h: StrHook) => { hooks.push(h) },
    afterParse: () => {}, beforeRender: () => {}, afterRender: () => {},
    onDocumentOpen: () => {}, onDocumentSave: () => {}, onSelectionChange: () => {},
    runBeforeParse: async (s: string) => s, runBeforeParseSync: (s: string) => s,
    runAfterRender: async (s: string) => s, runDocumentOpen: () => {}, runDocumentSave: () => {},
  },
  commands: { register: (cmd: { id: string }) => { commands.push(cmd.id) }, unregister: () => {} },
  triggers: { register: () => {}, unregister: () => {}, getAll: () => [], findConflict: () => undefined },
  files: { register: () => {}, unregister: () => {} },
  vault: {
    read: async (path: string) => { if (path in VAULT) return VAULT[path]; throw new Error(`Not found: ${path}`) },
    readDocumentByPath: async (path: string) => { if (path in VAULT) return VAULT[path]; throw new Error(`Not found: ${path}`) },
    write: async (path: string, content: string) => { VAULT[path] = content },
    list: async () => Object.keys(VAULT),
    exists: async (path: string) => path in VAULT,
    resolveDocumentId: (path: string) => (path in VAULT ? `doc:${path}` : undefined),
    getVaultId: () => 'vault-test',
    getToken: () => 'token-test',
  },
} as unknown as PluginAPI

beforeAll(async () => { await plugin.onload(stubAPI) })

const getSpec = () => { const s = specs[0]; if (!s) throw new Error('spec not registered'); return s }
const run = (s: string): string => hooks.reduce((acc, h) => { const r = h(acc); return typeof r === 'string' ? r : acc }, s)

// ── Block detect ──────────────────────────────────────────────────────────────

describe('block detect — @[[...]]', () => {
  const detect = (text: string) => { const s = getSpec(); if (!s.detect) return false; return s.detect instanceof RegExp ? s.detect.test(text) : s.detect(text) }
  it('detects @[[module.md]]', () => expect(detect('@[[module.md]]')).toBe(true))
  it('detects @[[modules/goals.md]]', () => expect(detect('@[[modules/goals.md]]')).toBe(true))
  it('does NOT detect ![[note.md]] (K1 — plugin-note-embed)', () => expect(detect('![[note.md]]')).toBe(false))
  it('does NOT detect [[wikilink]]', () => expect(detect('[[note.md]]')).toBe(false))
  it('does NOT detect plain text', () => expect(detect('plain text')).toBe(false))
})

// ── deserialize / serialize ───────────────────────────────────────────────────

describe('deserialize / serialize', () => {
  it('extracts path from @[[modules/goals.md]]', () => {
    expect((getSpec().deserialize('@[[modules/goals.md]]') as {path:string}).path).toBe('modules/goals.md')
  })
  it('round-trips', () => {
    expect(getSpec().serialize(getSpec().deserialize('@[[modules/goals.md]]'))).toBe('@[[modules/goals.md]]')
  })
})

// ── renderClient — K2 editable ────────────────────────────────────────────────

describe('renderClient — K2 module widget', () => {
  it('returns a styled container', () => {
    const el = getSpec().renderClient(getSpec().deserialize('@[[modules/goals.md]]'), { editorView: null })
    expect(el.tagName).toBe('DIV')
    expect(el.style.cssText).toContain('border')
  })
  it('contains mode buttons Auto/Module/Source', () => {
    const el = getSpec().renderClient(getSpec().deserialize('@[[modules/goals.md]]'), { editorView: null })
    expect(el.textContent).toContain('Auto')
    expect(el.textContent).toContain('Module')
    expect(el.textContent).toContain('Source')
  })
  it('starts in Loading state, then mounts an iframe when connected', async () => {
    const el = getSpec().renderClient(getSpec().deserialize('@[[modules/goals.md]]'), { editorView: null })
    expect(el.textContent).toContain('Loading')
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ grantToken: 'grant-test', permission: 'write' }),
    })) as typeof globalThis.fetch
    document.body.appendChild(el)
    try {
      await new Promise((r) => setTimeout(r, 20))
      expect(el.querySelector('iframe')).not.toBeNull()
    } finally {
      globalThis.fetch = originalFetch
      el.remove()
    }
  })
})

// ── beforeParse hook ──────────────────────────────────────────────────────────

describe('beforeParse — frontmatter handling', () => {
  it('passes plain content through unchanged', () => {
    expect(run('# Hello')).toBe('# Hello')
  })
  it('strips --- block and injects module banner for type=module', () => {
    const result = run('---\ntype: module\n---\n## Body')
    expect(result).not.toContain('type: module')
    expect(result).toContain('Module document')
    expect(result).toContain('## Body')
  })
  it('leaves non-module frontmatter unchanged', () => {
    const result = run('---\ntype: template\n---\n## Body')
    expect(result).toContain('type: template')
    expect(result).not.toContain('Module document')
  })
})

// ── Commands ──────────────────────────────────────────────────────────────────

describe('commands', () => {
  it('registers module:create', () => expect(commands).toContain('module:create'))
})
