// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Fichiers sans extracteur officiel : indexes par leur nom, puis par le
// texte qu'un membre a extrait sur son poste et publie dans l'annexe « texte ».
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeBackend } from './fakeBackend'
import { Peer, TOKEN, startPeer, tempDir, until } from './harness'

let backend: FakeBackend
let peer: Peer | undefined
let tmp: { dir: string; cleanup: () => void }

beforeEach(async () => {
  backend = await new FakeBackend({ token: TOKEN }).start()
  tmp = tempDir()
})

afterEach(async () => {
  await peer?.stop()
  peer = undefined
  await backend.stop()
  tmp.cleanup()
})

describe('fichiers lus sur le poste des membres', () => {
  it('un fichier sans texte publie est trouvable par son nom, des la construction', async () => {
    backend.writeNote('v1', 'n', 'Note.md', 'une note')
    backend.addFile('v1', 'f', 'Plans/Maquette pivoine.sketch')
    peer = await startPeer(backend, tmp.dir)
    await until(async () => (await peer!.status('v1')).body.status === 'ready', 10_000, 'construction')
    expect(await peer.found('v1', 'pivoine')).toEqual(['f'])
  })

  it('le texte publie dans l annexe rend le contenu cherchable, et suit ses mises a jour', async () => {
    peer = await startPeer(backend, tmp.dir)
    backend.addFile('v1', 'f', 'Devis.sketch')
    await until(async () => (await peer!.found('v1', 'devis')).length === 1, 5000, 'fichier par son nom')

    backend.publishText('v1', 'f', '# Devis\n\nmontant cyclamen')
    await until(async () => (await peer!.found('v1', 'cyclamen')).length === 1, 5000, 'texte publie')
    expect(await peer.found('v1', 'cyclamen')).toEqual(['f'])

    backend.publishText('v1', 'f', 'montant renouvele')
    await until(async () => (await peer!.found('v1', 'renouvele')).length === 1, 5000, 'texte republie')
    expect(await peer.found('v1', 'cyclamen')).toEqual([])
  })

  it('un document texte d un type inconnu du pair est lu par son propre texte', async () => {
    backend.writeNote('v1', 't', 'Brouillon.tex', 'formule lavande')
    peer = await startPeer(backend, tmp.dir)
    await until(async () => (await peer!.found('v1', 'lavande')).length === 1, 10_000, 'construction')
  })

  it('le texte publie avant la construction est lu par elle', async () => {
    backend.addFile('v1', 'f', 'Archive.sketch')
    backend.publishText('v1', 'f', 'mot glycine')
    peer = await startPeer(backend, tmp.dir)
    await until(async () => (await peer!.found('v1', 'glycine')).length === 1, 10_000, 'construction')
  })
})
