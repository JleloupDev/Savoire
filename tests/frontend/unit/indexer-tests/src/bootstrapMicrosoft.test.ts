// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// E5 (revue du 14/11) : l'adresse d'un compte Microsoft n'est jamais crue sans
// preuve. Le bootstrap Zitadel ne doit pas la declarer verifiee.
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

const src = readFileSync(new URL('../../../../../deploy/compose/zitadel/bootstrap.mjs', import.meta.url), 'utf8')

describe('bootstrap Zitadel, connexion Microsoft', () => {
  it('ne declare pas l adresse verifiee', () => {
    const block = src.slice(src.indexOf("name: 'Microsoft'"), src.indexOf('async function findIdp'))
    expect(block).toContain('emailVerified: false')
    expect(block).not.toContain('emailVerified: true')
  })

  it('SIGNUP_CLOSED ferme l inscription libre et la creation par un fournisseur externe', () => {
    expect(src).toContain("env('SIGNUP_CLOSED', 'false')")
    expect(src).toContain('allowRegister: !SIGNUP_CLOSED')
    expect(src).toContain('isCreationAllowed: !SIGNUP_CLOSED')
    expect(src).toContain('isAutoCreation: !SIGNUP_CLOSED')
  })
})
