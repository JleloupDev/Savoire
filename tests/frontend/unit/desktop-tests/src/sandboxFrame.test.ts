// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Cadre des boards et des plugins du store : la page du bureau, sinon
// /frame.html de l'appli web (sa propre CSP, voir nginx.conf.template).
import { describe, it, expect } from 'vitest'
import { sandboxFrameUrl } from '../../../../../apps/web/src/tauriRuntime'

const tauri = { isTauri: true, __TAURI_INTERNALS__: { invoke: async () => null } }

describe('sandboxFrameUrl', () => {
  it('web : la page cadre de l appli, sur la meme origine', () => {
    expect(sandboxFrameUrl({ location: { href: 'https://savoire.exemple.fr/v/abc', protocol: 'https:' } }, 'Mozilla/5.0'))
      .toBe('https://savoire.exemple.fr/frame.html')
  })
  it('bureau : le protocole savoire-board', () => {
    expect(sandboxFrameUrl(tauri, 'Mozilla/5.0 (X11; Linux)')).toBe('savoire-board://localhost/')
  })
  it('ni web ni bureau (tests, file:) : null, donc srcdoc', () => {
    expect(sandboxFrameUrl({}, '')).toBeNull()
    expect(sandboxFrameUrl({ location: { href: 'file:///x', protocol: 'file:' } }, '')).toBeNull()
  })
})
