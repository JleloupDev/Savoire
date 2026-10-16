// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Moteur de raccourcis : une touche declenche la commande qui y repond, avec
// les raccourcis par defaut ou ceux choisis par la personne.
import { describe, it, expect, vi } from 'vitest'
import { HotkeyManager, PluginActivation, PluginAPIImpl, PluginLoader, formatHotkey } from '@savoire/plugin-runtime'
import type { HotkeyEvent } from '@savoire/plugin-api'

function key(k: string, mods: Partial<Pick<HotkeyEvent, 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>> = {}, code?: string): HotkeyEvent & { prevented: boolean } {
  const e = {
    key: k,
    code: code ?? (/^[a-z]$/i.test(k) ? `Key${k.toUpperCase()}` : /^\d$/.test(k) ? `Digit${k}` : k),
    ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
    ...mods,
    prevented: false,
    preventDefault() { e.prevented = true },
  }
  return e
}

function setup(platform: 'mac' | 'other' = 'other') {
  const api = PluginAPIImpl.create()
  const hotkeys = new HotkeyManager(api.commands, platform)
  const bold = vi.fn()
  const open = vi.fn()
  api.commands.register({ id: 'editor:bold', label: 'Gras', editor: true, hotkeys: [{ modifiers: ['Mod'], key: 'b' }], run: bold })
  api.commands.register({ id: 'app:open', label: 'Ouvrir', hotkeys: [{ modifiers: ['Mod'], key: 'o' }], run: open })
  return { api, hotkeys, bold, open }
}

describe('HotkeyManager', () => {
  it('Ctrl+B declenche la commande et annule l\'evenement', () => {
    const { hotkeys, bold } = setup()
    const e = key('b', { ctrlKey: true })
    expect(hotkeys.handleKeyEvent(e, { editorView: {} })).toBe(true)
    expect(bold).toHaveBeenCalledWith({ editorView: {} })
    expect(e.prevented).toBe(true)
  })

  it('Mod vaut Cmd sur Mac, pas Ctrl', () => {
    const { hotkeys, bold } = setup('mac')
    expect(hotkeys.handleKeyEvent(key('b', { ctrlKey: true }), { editorView: {} })).toBe(false)
    expect(hotkeys.handleKeyEvent(key('b', { metaKey: true }), { editorView: {} })).toBe(true)
    expect(bold).toHaveBeenCalledTimes(1)
  })

  it('les modificateurs doivent correspondre exactement', () => {
    const { hotkeys, bold } = setup()
    expect(hotkeys.handleKeyEvent(key('B', { ctrlKey: true, shiftKey: true }), { editorView: {} })).toBe(false)
    expect(bold).not.toHaveBeenCalled()
  })

  it('une commande d\'edition est ignoree sans editeur ; une commande globale non', () => {
    const { hotkeys, bold, open } = setup()
    const e = key('b', { ctrlKey: true })
    expect(hotkeys.handleKeyEvent(e, { editorView: null })).toBe(false)
    expect(e.prevented).toBe(false)
    expect(bold).not.toHaveBeenCalled()
    expect(hotkeys.handleKeyEvent(key('o', { ctrlKey: true }), { editorView: null })).toBe(true)
    expect(open).toHaveBeenCalled()
  })

  it('une touche sans Ctrl, Alt ni Cmd sert a ecrire : jamais prise', () => {
    const { api, hotkeys } = setup()
    const run = vi.fn()
    api.commands.register({ id: 'x', hotkeys: [{ modifiers: [], key: 'a' }], run })
    expect(hotkeys.handleKeyEvent(key('a'), { editorView: {} })).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it('AltGr (Ctrl+Alt sous Windows) n\'est jamais pris : il sert a taper @, #...', () => {
    const { api, hotkeys } = setup()
    const run = vi.fn()
    api.commands.register({ id: 'x', hotkeys: [{ modifiers: ['Ctrl', 'Alt'], key: '0' }], run })
    const e = { ...key('@', { ctrlKey: true, altKey: true }, 'Digit0'), getModifierState: (k: string) => k === 'AltGraph' }
    expect(hotkeys.handleKeyEvent(e, { editorView: {} })).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it('Ctrl+Maj+7 marche en AZERTY : le chiffre est lu sur la touche', () => {
    const { api, hotkeys } = setup()
    const run = vi.fn()
    api.commands.register({ id: 'ol', editor: true, hotkeys: [{ modifiers: ['Mod', 'Shift'], key: '7' }], run })
    // AZERTY : Maj+touche 7 produit « 7 », sans Maj « è ».
    expect(hotkeys.handleKeyEvent(key('7', { ctrlKey: true, shiftKey: true }, 'Digit7'), { editorView: {} })).toBe(true)
    expect(run).toHaveBeenCalled()
  })

  it('un raccourci personnalise remplace celui par defaut ; null revient au defaut', () => {
    const { hotkeys, bold } = setup()
    const changed = vi.fn()
    hotkeys.onChange(changed)
    hotkeys.setCustom('editor:bold', [{ modifiers: ['Mod', 'Shift'], key: 'g' }])
    expect(changed).toHaveBeenCalled()
    expect(hotkeys.handleKeyEvent(key('b', { ctrlKey: true }), { editorView: {} })).toBe(false)
    expect(hotkeys.handleKeyEvent(key('G', { ctrlKey: true, shiftKey: true }), { editorView: {} })).toBe(true)
    expect(bold).toHaveBeenCalledTimes(1)
    expect(hotkeys.getCustom()).toEqual({ 'editor:bold': [{ modifiers: ['Mod', 'Shift'], key: 'g' }] })

    hotkeys.setCustom('editor:bold', null)
    expect(hotkeys.get('editor:bold')).toEqual([{ modifiers: ['Mod'], key: 'b' }])
  })

  it('[] retire tout raccourci a la commande', () => {
    const { hotkeys, bold } = setup()
    hotkeys.setCustom('editor:bold', [])
    expect(hotkeys.handleKeyEvent(key('b', { ctrlKey: true }), { editorView: {} })).toBe(false)
    expect(bold).not.toHaveBeenCalled()
  })

  it('signale les commandes qui repondent deja a un raccourci', () => {
    const { hotkeys } = setup()
    expect(hotkeys.findConflicts({ modifiers: ['Ctrl'], key: 'B' })).toEqual(['editor:bold'])
    expect(hotkeys.findConflicts({ modifiers: ['Mod', 'Shift'], key: 'b' })).toEqual([])
  })

  it('isAvailable faux : la touche suit son cours', () => {
    const { api, hotkeys } = setup()
    const run = vi.fn()
    api.commands.register({ id: 'y', hotkeys: [{ modifiers: ['Mod'], key: 'y' }], isAvailable: () => false, run })
    const e = key('y', { ctrlKey: true })
    expect(hotkeys.handleKeyEvent(e, { editorView: null })).toBe(false)
    expect(e.prevented).toBe(false)
  })

  it('formate selon la plateforme', () => {
    expect(formatHotkey({ modifiers: ['Mod', 'Shift'], key: 'h' }, 'other')).toBe('Ctrl+Maj+H')
    expect(formatHotkey({ modifiers: ['Mod', 'Shift'], key: 'h' }, 'mac')).toBe('⇧⌘H')
  })

  it('le raccourci d\'un plugin desactive ne fait rien, et revient a la reactivation', async () => {
    const api = PluginAPIImpl.create()
    const activation = new PluginActivation()
    api.attachActivation(activation)
    const run = vi.fn()
    await new PluginLoader().loadInternal({
      manifest: { id: 'p', name: 'P', version: '1', permissions: ['ui:editor'] },
      async onload(a) {
        a.commands.register({ id: 'p:act', hotkeys: [{ modifiers: ['Mod'], key: 'j' }], run })
        // Un plugin lit les raccourcis par l'API.
        expect(a.hotkeys?.get('p:act')).toEqual([{ modifiers: ['Mod'], key: 'j' }])
      },
      async onunload() {},
    }, api)
    activation.setDisabled(['p'])
    expect(api.hotkeys.handleKeyEvent(key('j', { ctrlKey: true }), { editorView: null })).toBe(false)
    expect(api.hotkeys.getDefault('p:act')).toEqual([{ modifiers: ['Mod'], key: 'j' }])
    activation.setDisabled([])
    expect(api.hotkeys.handleKeyEvent(key('j', { ctrlKey: true }), { editorView: null })).toBe(true)
    expect(run).toHaveBeenCalledTimes(1)
  })
})
