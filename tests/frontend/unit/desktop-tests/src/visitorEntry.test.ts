// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, expect, it } from 'vitest'
import { LANDING_PATH, visitorEntryPath } from '../../../../../apps/web/src/visitorEntry'

describe('visitorEntryPath', () => {
  it('montre la vitrine a une premiere visite dans le navigateur', () => {
    expect(visitorEntryPath({ desktop: false, savedAccounts: 0 })).toBe(LANDING_PATH)
  })
  it('va a la connexion quand un compte est deja enregistre', () => {
    expect(visitorEntryPath({ desktop: false, savedAccounts: 1 })).toBe('/login')
  })
  it('va a la connexion pour un telephone venu du code QR d une presentation', () => {
    expect(visitorEntryPath({ desktop: false, savedAccounts: 0, slideRemote: true })).toBe('/login')
  })
  it('va a la connexion dans l appli de bureau', () => {
    expect(visitorEntryPath({ desktop: true, savedAccounts: 0 })).toBe('/login')
  })
})
