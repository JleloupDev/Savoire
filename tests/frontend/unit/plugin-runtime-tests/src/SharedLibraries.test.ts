// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Bibliotheques communes des plugins : liste fermee, chargees a la demande,
// `require` d'un paquet CommonJS ; une bibliotheque hors liste est refusee.
import { describe, it, expect, vi } from 'vitest'
import { SharedLibraryRegistry, requiredLibraries, wrapCommonJs, isCommonJsPlugin } from '@savoire/plugin-runtime'
import { SHARED_LIBRARIES, UnknownLibraryError } from '@savoire/plugin-api'

describe('bibliotheques communes', () => {
  it('chargees une seule fois, a la demande ; get() avant load() echoue', async () => {
    const react = { createElement: () => 'el' }
    const loader = vi.fn(async () => react)
    const libs = new SharedLibraryRegistry().provide('react', loader)
    expect(libs.list()).toEqual(['react'])
    expect(() => libs.get('react')).toThrow(/pas encore chargée/)
    const [a, b] = await Promise.all([libs.load('react'), libs.load('react')])
    expect(a).toBe(react)
    expect(b).toBe(react)
    expect(loader).toHaveBeenCalledTimes(1)
    expect(libs.get('react')).toBe(react)
  })

  it('une bibliotheque hors liste, ou non fournie, est refusee', async () => {
    const libs = new SharedLibraryRegistry().provide('react', async () => ({}))
    await expect(libs.loadAll(['react', 'lodash'])).rejects.toBeInstanceOf(UnknownLibraryError)
    await expect(libs.loadAll(['@codemirror/view'])).rejects.toThrow(/non fournie/)
    expect(() => libs.provide('yjs' as never, async () => ({}))).toThrow(UnknownLibraryError)
    expect(SHARED_LIBRARIES).not.toContain('yjs')
  })

  it('un paquet CommonJS : ses require() sont reperes, fournis, et son export est le plugin', async () => {
    const code = `
      const React = require('react');
      const { EditorView } = require("@codemirror/view");
      module.exports = { manifest: { id: 'externe', name: 'Externe', version: '1' }, onload() { return React.version + EditorView.name } };
    `
    expect(requiredLibraries(code).sort()).toEqual(['@codemirror/view', 'react'])
    expect(isCommonJsPlugin(code)).toBe(true)
    expect(isCommonJsPlugin('globalThis.__poc_plugin__ = {}')).toBe(false)
    const libs = new SharedLibraryRegistry()
      .provide('react', async () => ({ version: '18' }))
      .provide('@codemirror/view', async () => ({ EditorView: { name: 'CM' } }))
    await libs.loadAll(requiredLibraries(code))
    ;(globalThis as Record<string, unknown>).__testRequire = libs.createRequire()
    const mod = await import(/* @vite-ignore */ `data:text/javascript,${encodeURIComponent(wrapCommonJs(code, '__testRequire'))}`) as { default: { manifest: { id: string }; onload(): string } }
    expect(mod.default.manifest.id).toBe('externe')
    expect(mod.default.onload()).toBe('18CM')
    expect(() => (libs.createRequire())('fs')).toThrow(UnknownLibraryError)
  })
})
