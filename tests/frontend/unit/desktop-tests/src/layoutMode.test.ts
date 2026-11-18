// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Interface mobile ou bureau : selon la taille de l'ecran et le pointeur.
import { describe, it, expect } from 'vitest'
import { chooseLayout } from '../../../../../apps/web/src/layoutMode'

describe('chooseLayout', () => {
  it('telephone : mobile, en portrait comme en paysage', () => {
    expect(chooseLayout({ width: 390, height: 844, finePointer: false })).toBe('mobile')
    expect(chooseLayout({ width: 844, height: 390, finePointer: false })).toBe('mobile')
  })

  it('tablette sans pave tactile : mobile en portrait, bureau en grand paysage', () => {
    expect(chooseLayout({ width: 820, height: 1180, finePointer: false })).toBe('mobile')
    expect(chooseLayout({ width: 1180, height: 820, finePointer: false })).toBe('desktop')
  })

  it('tablette avec clavier a pave tactile : bureau', () => {
    expect(chooseLayout({ width: 820, height: 1180, finePointer: true })).toBe('desktop')
  })

  it('ordinateur : bureau', () => {
    expect(chooseLayout({ width: 1440, height: 900, finePointer: true })).toBe('desktop')
  })

  it('le choix force passe avant la regle', () => {
    expect(chooseLayout({ width: 1440, height: 900, finePointer: true }, 'mobile')).toBe('mobile')
    expect(chooseLayout({ width: 390, height: 844, finePointer: false }, 'desktop')).toBe('desktop')
  })
})
