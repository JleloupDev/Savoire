// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect } from 'vitest'
import { BlockRegistryImpl, HookRegistryImpl, PluginAPIImpl } from '@savoire/plugin-runtime'

describe('BlockRegistryImpl', () => {
  it('registers and detects a spec by regex', () => {
    const r = new BlockRegistryImpl()
    r.register({ type: 'callout', detect: /^\[!/, serialize: s => String(s), deserialize: s => s, createEditorWidget: () => ({ mount: () => {}, destroy: () => {} }), renderClient: () => document.createElement('div') })
    expect(r.detectBlock('[!NOTE] hello')).not.toBeNull()
  })

  it('returns null when nothing matches', () => {
    const r = new BlockRegistryImpl()
    expect(r.detectBlock('plain text')).toBeNull()
  })

  it('detects by function predicate', () => {
    const r = new BlockRegistryImpl()
    r.register({ type: 'custom', detect: (t) => t.startsWith('CUSTOM:'), serialize: s => String(s), deserialize: s => s, createEditorWidget: () => ({ mount: () => {}, destroy: () => {} }), renderClient: () => document.createElement('div') })
    expect(r.detectBlock('CUSTOM: data')).not.toBeNull()
    expect(r.detectBlock('other')).toBeNull()
  })

  it('unregisters a spec', () => {
    const r = new BlockRegistryImpl()
    r.register({ type: 'foo', detect: /^foo/, serialize: s => String(s), deserialize: s => s, createEditorWidget: () => ({ mount: () => {}, destroy: () => {} }), renderClient: () => document.createElement('div') })
    r.unregister('foo')
    expect(r.detectBlock('foo bar')).toBeNull()
  })
})

describe('HookRegistryImpl.runBeforeParseSync', () => {
  it('applies sync hooks in order', () => {
    const h = new HookRegistryImpl()
    h.beforeParse(s => s.toUpperCase())
    h.beforeParse(s => `[${s}]`)
    expect(h.runBeforeParseSync('hello')).toBe('[HELLO]')
  })

  it('skips hooks that return a Promise', () => {
    const h = new HookRegistryImpl()
    h.beforeParse(async s => s + '-async')  // should be skipped
    h.beforeParse(s => s + '-sync')
    expect(h.runBeforeParseSync('x')).toBe('x-sync')
  })

  it('returns original string when no hooks registered', () => {
    const h = new HookRegistryImpl()
    expect(h.runBeforeParseSync('unchanged')).toBe('unchanged')
  })
})

describe('HookRegistryImpl.runBeforeParse (async)', () => {
  it('applies all hooks including async', async () => {
    const h = new HookRegistryImpl()
    h.beforeParse(s => s.toUpperCase())
    h.beforeParse(async s => `[${s}]`)
    expect(await h.runBeforeParse('hello')).toBe('[HELLO]')
  })
})

describe('PluginAPIImpl.create', () => {
  it('creates with all registries initialized', () => {
    const api = PluginAPIImpl.create()
    expect(api.blocks).toBeDefined()
    expect(api.hooks).toBeDefined()
    expect(api.commands).toBeDefined()
    expect(api.files).toBeDefined()
    expect(api.vault).toBeDefined()
  })
})
