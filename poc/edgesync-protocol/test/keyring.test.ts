// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect } from 'vitest'
import { Keyring } from '../src/core/keyring'
import { encrypt, decrypt, randomBytes, resourceId } from '../src/core/envelope'

const rand = () => randomBytes(32)
const RID_DIR = resourceId('vault-1/dir')
const RID_DOC1 = resourceId('vault-1/doc/1')
const RID_DOC2 = resourceId('vault-1/doc/2')

describe('keyring — modele en enveloppe K_vault -> N K_doc (multi-canal)', () => {
  it('genesis cree l epoque 0 avec K_vault seul, aucun canal encore', () => {
    const kr = Keyring.genesis(rand)
    expect(kr.currentEpoch()).toBe(0)
    expect(kr.vaultKey(0)).toBeInstanceOf(Uint8Array)
    expect(kr.docKey(0, RID_DIR)).toBeUndefined()
    expect(kr.knownResources(0)).toHaveLength(0)
  })

  it('mintDocKey mint un canal sous le K_vault courant, idempotent', () => {
    const kr = Keyring.genesis(rand)
    const k1 = kr.mintDocKey(0, RID_DIR, rand)
    const k2 = kr.mintDocKey(0, RID_DIR, rand) // deuxieme appel: retourne la meme cle
    expect(k1).toEqual(k2)
    expect(kr.docKey(0, RID_DIR)).toEqual(k1)
  })

  it('plusieurs canaux distincts sous une meme epoque ont des K_doc distincts', () => {
    const kr = Keyring.genesis(rand)
    kr.mintDocKey(0, RID_DIR, rand)
    kr.mintDocKey(0, RID_DOC1, rand)
    kr.mintDocKey(0, RID_DOC2, rand)
    const ids = kr.knownResources(0).map((r) => Buffer.from(r).toString('hex')).sort()
    const expected = [RID_DIR, RID_DOC1, RID_DOC2].map((r) => Buffer.from(r).toString('hex')).sort()
    expect(ids).toEqual(expected)
    expect(kr.docKey(0, RID_DOC1)).not.toEqual(kr.docKey(0, RID_DOC2))
  })

  it('rotate ouvre une nouvelle epoque avec un K_vault distinct et re-mint un K_doc frais par canal connu', () => {
    const kr = Keyring.genesis(rand)
    kr.mintDocKey(0, RID_DIR, rand)
    kr.mintDocKey(0, RID_DOC1, rand)
    const before = { dir: kr.docKey(0, RID_DIR)!, doc1: kr.docKey(0, RID_DOC1)! }

    const next = kr.rotate(rand)
    expect(next.epoch).toBe(1)
    expect(kr.currentEpoch()).toBe(1)
    // nouvelles cles, distinctes des anciennes (pas un re-wrap)
    expect(kr.docKey(1, RID_DIR)).not.toEqual(before.dir)
    expect(kr.docKey(1, RID_DOC1)).not.toEqual(before.doc1)
    // l historique conserve les anciennes cles (lecture du passe)
    expect(kr.docKey(0, RID_DIR)).toEqual(before.dir)
    expect(kr.docKey(0, RID_DOC1)).toEqual(before.doc1)
    // un canal cree APRES rotation n'existait pas avant: rien a re-minter pour lui
    expect(kr.knownResources(1).length).toBe(2)
  })

  it('delivery + import : un pair vide reconstruit tous les K_doc du lot', () => {
    const founder = Keyring.genesis(rand)
    founder.mintDocKey(0, RID_DIR, rand)
    founder.mintDocKey(0, RID_DOC1, rand)
    const d = founder.delivery(0)!
    expect(d.docWraps).toHaveLength(2)

    const member = Keyring.empty()
    member.import(0, d.vaultKey, d.docWraps)
    expect(member.docKey(0, RID_DIR)).toEqual(founder.docKey(0, RID_DIR))
    expect(member.docKey(0, RID_DOC1)).toEqual(founder.docKey(0, RID_DOC1))
    expect(member.currentEpoch()).toBe(0)
  })

  it('import est une union : un import ulterieur avec un nouveau canal enrichit le keyring existant', () => {
    const founder = Keyring.genesis(rand)
    founder.mintDocKey(0, RID_DIR, rand)
    const member = Keyring.empty()
    member.import(0, founder.delivery(0)!.vaultKey, founder.delivery(0)!.docWraps)

    // un nouveau canal apparait cote founder, et est re-livre au membre
    founder.mintDocKey(0, RID_DOC1, rand)
    member.import(0, founder.delivery(0)!.vaultKey, founder.delivery(0)!.docWraps)

    expect(member.docKey(0, RID_DIR)).toEqual(founder.docKey(0, RID_DIR)) // inchange
    expect(member.docKey(0, RID_DOC1)).toEqual(founder.docKey(0, RID_DOC1)) // nouveau, recupere
  })

  it('partage de note : importDocKey donne la lecture d un seul canal sans K_vault', () => {
    const founder = Keyring.genesis(rand)
    founder.mintDocKey(0, RID_DOC1, rand)
    const docKey = founder.docKey(0, RID_DOC1)!
    // une op chiffree sous K_doc par un membre
    const { nonce, ciphertext } = encrypt(docKey, new TextEncoder().encode('note'))
    // un non-membre recoit seulement K_doc (jamais K_vault)
    const outsider = Keyring.empty()
    outsider.importDocKey(0, RID_DOC1, docKey)
    expect(outsider.vaultKey(0)).toEqual(new Uint8Array(0)) // pas de cle vault
    const plain = decrypt(outsider.docKey(0, RID_DOC1)!, nonce, ciphertext)
    expect(new TextDecoder().decode(plain)).toBe('note')
  })

  it('deux pairs deja membres (meme K_vault) qui mintent independamment le meme canal convergent sur une seule K_doc', () => {
    // Unlike K_vault (one election per room, e.g. EdgeSyncHub.ClaimOwner), a
    // single resourceId's K_doc has no designated "creator" — ANY granting
    // member may legitimately mint a new channel on its own (§6.3). Two
    // already-synced peers opening the SAME channel (e.g. an index namespace
    // every member opens eagerly on vault activation) before receiving each
    // other's grant is the common case, not an edge case.
    // Both peers already possess the same K_vault (simulating "already
    // granted earlier via the directory channel") — Keyring.empty() + one
    // import() each, since Keyring.genesis() would mint two DIFFERENT
    // vaultKeys and defeat the point of this test.
    const sharedVaultKey = rand()
    const a = Keyring.empty()
    const b = Keyring.empty()
    a.import(0, sharedVaultKey, [])
    b.import(0, sharedVaultKey, [])

    a.mintDocKey(0, RID_DOC1, rand)
    b.mintDocKey(0, RID_DOC1, rand)
    expect(a.docKey(0, RID_DOC1)).not.toEqual(b.docKey(0, RID_DOC1)) // genuinely raced

    // Each delivers its own grant to the other — symmetric exchange.
    const deliveryA = a.delivery(0)!
    const deliveryB = b.delivery(0)!
    a.import(0, deliveryB.vaultKey, deliveryB.docWraps)
    b.import(0, deliveryA.vaultKey, deliveryA.docWraps)

    // Deterministic, independently-reached agreement — no round-trip needed.
    expect(a.docKey(0, RID_DOC1)).toEqual(b.docKey(0, RID_DOC1))
  })

  it('serialize/deserialize preserve tous les canaux de toutes les epoques', () => {
    const kr = Keyring.genesis(rand)
    kr.mintDocKey(0, RID_DIR, rand)
    kr.mintDocKey(0, RID_DOC1, rand)
    kr.rotate(rand)
    kr.mintDocKey(1, RID_DOC2, rand)

    const bytes = kr.serialize()
    const kr2 = Keyring.deserialize(bytes)
    expect(kr2.currentEpoch()).toBe(1)
    expect(kr2.docKey(0, RID_DIR)).toEqual(kr.docKey(0, RID_DIR))
    expect(kr2.docKey(0, RID_DOC1)).toEqual(kr.docKey(0, RID_DOC1))
    expect(kr2.docKey(1, RID_DIR)).toEqual(kr.docKey(1, RID_DIR))
    expect(kr2.docKey(1, RID_DOC2)).toEqual(kr.docKey(1, RID_DOC2))
  })
})
