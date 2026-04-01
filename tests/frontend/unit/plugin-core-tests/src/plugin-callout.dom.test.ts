// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, beforeAll } from 'vitest'
import type { BlockSpec } from '@savoire/plugin-api'
import plugin from '@savoire/plugin-callout'

let spec: BlockSpec | undefined

const stubAPI = {
  blocks: {
    register: (s: BlockSpec) => { spec = s },
    unregister: () => {}, detectBlock: () => null, getAll: () => [],
  },
  hooks: { beforeParse: () => {}, afterParse: () => {}, beforeRender: () => {}, afterRender: () => {}, onDocumentOpen: () => {}, onDocumentSave: () => {}, onSelectionChange: () => {}, runBeforeParse: async (s: string) => s, runBeforeParseSync: (s: string) => s, runAfterRender: async (s: string) => s, runDocumentOpen: () => {}, runDocumentSave: () => {} },
  commands: { register: () => {}, unregister: () => {} },
  triggers: { register: () => {}, unregister: () => {}, getAll: () => [], findConflict: () => undefined },
  files: { register: () => {}, unregister: () => {} },
  vault: {
    read: async () => '',
    readDocumentByPath: async () => '',
    write: async () => {},
    list: async () => [],
    exists: async () => false,
    resolveDocumentId: () => undefined,
  },
}

beforeAll(async () => { await plugin.onload(stubAPI as never) })

const getSpec = () => { if (!spec) throw new Error('spec not registered'); return spec }
const detect = (text: string) => { const s = getSpec(); if (!s.detect) return false; return s.detect instanceof RegExp ? s.detect.test(text) : s.detect(text) }

describe('detect', () => {
  it('detects > [!NOTE]', () => { expect(detect('> [!NOTE]\n> x')).toBe(true) })
  it('detects any word type', () => { expect(detect('> [!CUSTOM]\n> x')).toBe(true) })
  it('does not detect plain blockquote', () => { expect(detect('> plain')).toBe(false) })
})

describe('deserialize', () => {
  it('extracts NOTE type', () => { expect((getSpec().deserialize('> [!NOTE]\n> hi') as {type:string}).type).toBe('NOTE') })
  it('strips > prefix', () => { expect((getSpec().deserialize('> [!NOTE]\n> a\n> b') as {content:string}).content).toBe('a\nb') })
  it('preserves unknown type name', () => { expect((getSpec().deserialize('> [!UNKNOWN]\n> x') as {type:string}).type).toBe('UNKNOWN') })
  it('handles WARNING', () => {
    const d = getSpec().deserialize('> [!WARNING]\n> careful') as {type:string;content:string}
    expect(d.type).toBe('WARNING'); expect(d.content).toBe('careful')
  })
})

describe('serialize', () => {
  it('round-trips', () => {
    const data = getSpec().deserialize('> [!TIP]\n> tip text')
    const out = getSpec().serialize(data)
    expect(out).toContain('[!TIP]'); expect(out).toContain('tip text')
  })
})

describe('renderClient', () => {
  it('produces .callout with .callout-title and .callout-body', () => {
    const el = getSpec().renderClient(getSpec().deserialize('> [!NOTE]\n> hi'), { editorView: null })
    expect(el.className).toContain('callout')
    expect(el.querySelector('.callout-title')).not.toBeNull()
    expect(el.querySelector('.callout-body')).not.toBeNull()
  })
  it('applies border-left style', () => {
    const el = getSpec().renderClient(getSpec().deserialize('> [!NOTE]\n> hi'), { editorView: null })
    expect(el.style.cssText).toContain('border-left')
  })
  it('title contains type label', () => {
    const el = getSpec().renderClient(getSpec().deserialize('> [!WARNING]\n> x'), { editorView: null })
    expect((el.querySelector('.callout-title') as HTMLElement).textContent?.toLowerCase()).toContain('warning')
  })
})
