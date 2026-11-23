// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Apparence > Texte : interligne et espace avant les titres, comme dans
// Word. Le theme donne les valeurs ; ce qu'on change se pose sur <body>.
import { describe, it, expect, beforeEach } from 'vitest'
import { clean, setTypography, typography, typographyVariables } from '../../../../../apps/web/src/typography'

describe('Mise en page du texte', () => {
  beforeEach(() => setTypography({}))

  it('rien de choisi : les valeurs du theme', () => {
    expect(Object.values(typographyVariables({})).every(v => v === null)).toBe(true)
    expect(document.body.style.getPropertyValue('--plume-h1-before')).toBe('')
  })

  it('les titres 4 a 6 vont ensemble, en points', () => {
    const vars = typographyVariables({ lineHeight: 2, before: { 2: 30, 4: 3 } })
    expect(vars['--plume-line-height']).toBe('2')
    expect(vars['--plume-h2-before']).toBe('30pt')
    expect(vars['--plume-h1-before']).toBeNull()
    expect([vars['--plume-h4-before'], vars['--plume-h5-before'], vars['--plume-h6-before']]).toEqual(['3pt', '3pt', '3pt'])
  })

  it('les valeurs choisies se posent sur body, et se retirent', () => {
    setTypography({ before: { 1: 20 } })
    expect(document.body.style.getPropertyValue('--plume-h1-before')).toBe('20pt')
    expect(localStorage.getItem('savoire-typography')).toContain('20')
    setTypography({})
    expect(document.body.style.getPropertyValue('--plume-h1-before')).toBe('')
    expect(localStorage.getItem('savoire-typography')).toBeNull()
  })

  it('des valeurs insensees sont bornees ou ignorees', () => {
    expect(clean({ lineHeight: 9, before: { 1: -4, 2: Number.NaN } as never })).toEqual({ lineHeight: 3, before: { 1: 0 } })
    expect(typography()).toEqual({})
  })
})
