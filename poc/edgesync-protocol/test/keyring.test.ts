// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect } from 'vitest'
import { Keyring } from '../src/core/keyring'
import { encrypt, decrypt, randomBytes } from '../src/core/envelope'

const rand = () => randomBytes(32)

describe('keyring — modele en enveloppe K_vault -> K_doc', () => {
  it('genesis cree l epoque 0 avec une cle de doc', () => {
    const kr = Keyring.genesis(rand)
    expect(kr.currentEpoch()).toBe(0)
    expect(kr.docKey(0)).toBeInstanceOf(Uint8Array)
    expect(kr.vaultKey(0)).toBeInstanceOf(Uint8Array)
  })

  it('rotate ouvre une nouvelle epoque avec des cles distinctes', () => {
    const kr = Keyring.genesis(rand)
    const before = kr.docKey(0)!
    const next = kr.rotate(rand)
    expect(next.epoch).toBe(1)
    expect(kr.currentEpoch()).toBe(1)
    expect(kr.docKey(1)).not.toEqual(before)
    // l historique conserve l ancienne cle (lecture du passe)
    expect(kr.docKey(0)).toEqual(before)
  })

  it('delivery + import : un pair vide reconstruit la meme K_doc', () => {
    const founder = Keyring.genesis(rand)
    const d = founder.delivery(0)!
    const member = Keyring.empty()
    member.import(0, d.vaultKey, d.docWrap)
    expect(member.docKey(0)).toEqual(founder.docKey(0))
    expect(member.currentEpoch()).toBe(0)
  })

  it('partage de note : importDocKey donne la lecture sans K_vault', () => {
    const founder = Keyring.genesis(rand)
    const docKey = founder.docKey(0)!
    // une op chiffree sous K_doc par un membre
    const { nonce, ciphertext } = encrypt(docKey, new TextEncoder().encode('note'))
    // un non-membre recoit seulement K_doc (jamais K_vault)
    const outsider = Keyring.empty()
    outsider.importDocKey(0, docKey)
    expect(outsider.vaultKey(0)).toEqual(new Uint8Array(0)) // pas de cle vault
    const plain = decrypt(outsider.docKey(0)!, nonce, ciphertext)
    expect(new TextDecoder().decode(plain)).toBe('note')
  })
})
