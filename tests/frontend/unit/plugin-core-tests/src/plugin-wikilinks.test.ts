// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, beforeAll } from 'vitest'
import { createWikilinksPlugin } from '@savoire/plugin-wikilinks'
const plugin = createWikilinksPlugin({ belowOf: 'plugin-inspector' })
import type { PluginAPI } from '@savoire/plugin-api'

// ── Stub API ──────────────────────────────────────────────────────────────────

type StrHook = (s: string) => string | Promise<string>
const hooks: StrHook[] = []

const stubAPI = {
  blocks: { register: () => {}, unregister: () => {}, detectBlock: () => null, getAll: () => [] },
  hooks: {
    beforeParse: (h: StrHook) => { hooks.push(h) },
    afterParse: () => {}, beforeRender: () => {}, afterRender: () => {},
    onDocumentOpen: () => {}, onDocumentSave: () => {}, onSelectionChange: () => {},
    runBeforeParse: async (s: string) => s,
    runBeforeParseSync: (s: string) => s,
    runAfterRender: async (s: string) => s,
    runDocumentOpen: () => {}, runDocumentSave: () => {},
  },
  commands: { register: () => {}, unregister: () => {} },
  triggers: { register: () => {}, unregister: () => {}, getAll: () => [], findConflict: () => undefined },
  files: { register: () => {}, unregister: () => {}, getAll: () => [], getByExtension: () => undefined },
  views: { register: () => {}, unregister: () => {}, getAll: () => [] },
  index: { register: () => {}, registerFactory: () => {}, unregister: () => {}, getAll: () => [], rebuild: () => {} },
  vault: {
    read: async () => '',
    readDocumentByPath: async () => '',
    write: async () => {},
    list: async () => [],
    exists: async () => false,
    resolveDocumentId: () => undefined,
  },
} as unknown as PluginAPI

beforeAll(async () => {
  await plugin.onload(stubAPI)
})

// Run text through all registered beforeParse hooks synchronously
const run = (s: string) =>
  hooks.reduce((acc, h) => {
    const r = h(acc)
    return typeof r === 'string' ? r : acc
  }, s)

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('plugin-wikilinks — basic transforms', () => {
  it('transforms [[Target]] to a markdown link', () => {
    const result = run('See [[note.md]] for details')
    expect(result).toContain('[note.md]')
    expect(result).not.toContain('[[note.md]]')
  })

  it('uses the target as both label and href', () => {
    expect(run('[[goals]]')).toBe('[goals](#goals)')
  })

  it('handles multiple wikilinks on one line', () => {
    const result = run('[[A]] and [[B]]')
    expect(result).toContain('[A](#A)')
    expect(result).toContain('[B](#B)')
    expect(result).not.toContain('[[')
  })

  it('handles wikilinks with spaces in name', () => {
    const result = run('[[My Note]]')
    expect(result).toContain('[My Note]')
    expect(result).not.toContain('[[')
  })

  it('does not alter plain text without wikilinks', () => {
    expect(run('Hello world')).toBe('Hello world')
  })
})

describe('plugin-wikilinks — embed exclusion', () => {
  it('does NOT transform ![[embed]] (handled by plugin-note-embed)', () => {
    const result = run('![[note.md]]')
    // Must remain unchanged — the embed plugin handles this
    expect(result).toBe('![[note.md]]')
  })

  it('does NOT transform ![[embed]] mixed with regular wikilinks', () => {
    const result = run('See [[ref]] and ![[embed.md]]')
    // Wikilink transformed, embed left alone
    expect(result).toContain('[ref](#ref)')
    expect(result).toContain('![[embed.md]]')
  })

  it('does NOT transform multiple embeds', () => {
    const result = run('![[a.md]] and ![[b.md]]')
    expect(result).toBe('![[a.md]] and ![[b.md]]')
  })
})
