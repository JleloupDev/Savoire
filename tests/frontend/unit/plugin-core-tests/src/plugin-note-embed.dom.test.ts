// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, beforeAll, vi } from 'vitest'
import plugin from '@savoire/plugin-note-embed'
import type { BlockSpec, PluginAPI } from '@savoire/plugin-api'

const VAULT: Record<string, string> = {
  'note.md': `## Hello\n\nThis is the **embedded** note.\n\n- Item A\n- Item B\n`,
  'with-frontmatter.md': `---\ntitle: My Note\n---\n## Title\n\nBody content.\n`,
}

let spec: BlockSpec | undefined

const stubAPI = {
  blocks: {
    register: (s: BlockSpec) => { spec = s },
    unregister: () => {}, detectBlock: () => null, getAll: () => [],
  },
  hooks: {
    beforeParse: () => {}, afterParse: () => {}, beforeRender: () => {}, afterRender: () => {},
    onDocumentOpen: () => {}, onDocumentSave: () => {}, onSelectionChange: () => {},
    runBeforeParse: async (s: string) => s, runBeforeParseSync: (s: string) => s,
    runAfterRender: async (s: string) => s, runDocumentOpen: () => {}, runDocumentSave: () => {},
  },
  commands: { register: () => {}, unregister: () => {} },
  triggers: { register: () => {}, unregister: () => {}, getAll: () => [], findConflict: () => undefined },
  files: { register: () => {}, unregister: () => {} },
  vault: {
    read: async (path: string) => { if (path in VAULT) return VAULT[path]; throw new Error(`Not found: ${path}`) },
    readDocumentByPath: async (path: string) => { if (path in VAULT) return VAULT[path]; throw new Error(`Not found: ${path}`) },
    write: async () => {}, list: async () => Object.keys(VAULT), exists: async (path: string) => path in VAULT,
  },
} as unknown as PluginAPI

beforeAll(async () => { await plugin.onload(stubAPI) })
const getSpec = () => { if (!spec) throw new Error('spec not registered'); return spec }

describe('detect', () => {
  const detect = (text: string) => { const s = getSpec(); if (!s.detect) return false; return s.detect instanceof RegExp ? s.detect.test(text) : s.detect(text) }
  it('detects ![[note.md]]', () => expect(detect('![[note.md]]')).toBe(true))
  it('detects ![[folder/note.md]]', () => expect(detect('![[folder/note.md]]')).toBe(true))
  it('detects ![[note|alias]]', () => expect(detect('![[note|alias]]')).toBe(true))
  it('detects ![[note#Heading]]', () => expect(detect('![[note#Heading]]')).toBe(true))
  it('does NOT detect [[note.md]] (wikilink)', () => expect(detect('[[note.md]]')).toBe(false))
  it('does NOT detect @[[module.md]] (K2 — plugin-module)', () => expect(detect('@[[module.md]]')).toBe(false))
  it('does NOT detect plain text', () => expect(detect('Hello world')).toBe(false))
  it('does NOT detect when mixed with surrounding text', () => expect(detect('prefix ![[note.md]] suffix')).toBe(false))
})

describe('deserialize', () => {
  it('extracts the raw target and normalized path', () => {
    const out = getSpec().deserialize('![[note.md]]') as { raw: string; targetPath: string }
    expect(out.raw).toBe('note.md')
    expect(out.targetPath).toBe('note.md')
  })
  it('extracts nested paths', () => expect((getSpec().deserialize('![[folder/note.md]]') as {targetPath:string}).targetPath).toBe('folder/note.md'))
  it('drops alias from target path', () => expect((getSpec().deserialize('![[note.md|My title]]') as {targetPath:string}).targetPath).toBe('note.md'))
  it('drops heading from target path', () => expect((getSpec().deserialize('![[note.md#Section]]') as {targetPath:string}).targetPath).toBe('note.md'))
  it('returns empty targetPath for malformed input', () => expect((getSpec().deserialize('not an embed') as {targetPath:string}).targetPath).toBe(''))
})

describe('serialize', () => {
  it('round-trips', () => expect(getSpec().serialize(getSpec().deserialize('![[note.md]]'))).toBe('![[note.md]]'))
  it('preserves alias in raw target', () => expect(getSpec().serialize(getSpec().deserialize('![[note.md|Alias]]'))).toBe('![[note.md|Alias]]'))
  it('supports raw string input through shared normalization logic', () => expect(getSpec().serialize('![[note.md#Heading]]')).toBe('![[note.md#Heading]]'))
})

describe('renderClient — K1 read-only', () => {
  it('returns a .note-embed container immediately', () => {
    expect(getSpec().renderClient(getSpec().deserialize('![[note.md]]'), { editorView: null }).className).toContain('note-embed')
  })
  it('shows loading state before async resolves', async () => {
    const original = stubAPI.vault.readDocumentByPath
    stubAPI.vault.readDocumentByPath = vi.fn(async () =>
      new Promise<string>((resolve) => setTimeout(() => resolve('## Delayed'), 20)),
    ) as typeof stubAPI.vault.readDocumentByPath
    try {
      const el = getSpec().renderClient(getSpec().deserialize('![[loading.md]]'), { editorView: null })
      expect(el.querySelector('.note-embed-body')?.textContent).toContain('Loading')
      await new Promise((r) => setTimeout(r, 30))
    } finally {
      stubAPI.vault.readDocumentByPath = original
    }
  })
  it('fills body with HTML after vault.read', async () => {
    const el = getSpec().renderClient(getSpec().deserialize('![[note.md]]'), { editorView: null })
    await new Promise((r) => setTimeout(r, 50))
    expect(el.querySelector('.note-embed-body')?.innerHTML).not.toContain('Loading')
  })
  it('renders bold markdown as <strong>', async () => {
    const el = getSpec().renderClient(getSpec().deserialize('![[note.md]]'), { editorView: null })
    await new Promise((r) => setTimeout(r, 50))
    expect(el.querySelector('.note-embed-body')?.innerHTML).toContain('<strong>')
  })
  it('does NOT render a textarea (K1 is read-only)', async () => {
    const el = getSpec().renderClient(getSpec().deserialize('![[note.md]]'), { editorView: null })
    await new Promise((r) => setTimeout(r, 50))
    expect(el.querySelector('textarea')).toBeNull()
  })
  it('strips frontmatter before rendering', async () => {
    const el = getSpec().renderClient(getSpec().deserialize('![[with-frontmatter.md]]'), { editorView: null })
    await new Promise((r) => setTimeout(r, 50))
    expect(el.querySelector('.note-embed-body')?.innerHTML).not.toContain('title:')
    expect(el.querySelector('.note-embed-body')?.innerHTML).toContain('Body content')
  })
  it('shows error for missing file', async () => {
    const el = getSpec().renderClient(getSpec().deserialize('![[missing.md]]'), { editorView: null })
    await new Promise((r) => setTimeout(r, 50))
    expect(el.querySelector('.note-embed-body')?.textContent).toContain('Could not load')
  })
  it('loads underlying note when alias is present', async () => {
    const el = getSpec().renderClient(getSpec().deserialize('![[note.md|Alias]]'), { editorView: null })
    await new Promise((r) => setTimeout(r, 50))
    expect(el.querySelector('.note-embed-body')?.innerHTML).toContain('embedded')
  })
  it('loads underlying note when heading ref is present', async () => {
    const el = getSpec().renderClient(getSpec().deserialize('![[note.md#Heading]]'), { editorView: null })
    await new Promise((r) => setTimeout(r, 50))
    expect(el.querySelector('.note-embed-body')?.innerHTML).toContain('embedded')
  })
  it('uses the same parser when renderClient receives a raw embed string', async () => {
    const el = getSpec().renderClient('![[note.md|Alias]]', { editorView: null })
    await new Promise((r) => setTimeout(r, 50))
    expect(el.querySelector('.note-embed-body')?.innerHTML).toContain('embedded')
  })
  it('calls plugin vault API on each render for the same embed path', async () => {
    let resolveRead: (value: string) => void = () => { throw new Error('read not started') }
    const original = stubAPI.vault.readDocumentByPath
    const readSpy = vi.fn(async (_path: string) => new Promise<string>((resolve) => {
      resolveRead = resolve
    }))
    stubAPI.vault.readDocumentByPath = readSpy as typeof stubAPI.vault.readDocumentByPath
    try {
      getSpec().renderClient(getSpec().deserialize('![[slow.md]]'), { editorView: null })
      getSpec().renderClient(getSpec().deserialize('![[slow.md]]'), { editorView: null })
      expect(readSpy).toHaveBeenCalledTimes(2)
      resolveRead('## Shared\n\ncontent')
      await new Promise((r) => setTimeout(r, 30))
    } finally {
      stubAPI.vault.readDocumentByPath = original
    }
  })
})
