// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Acceptance scenarios S1-S6 from the spec (§10), exercised over a REAL
// WebSocket loopback connection between two independent VaultClient instances
// — proves the whole chain (multi-channel Keyring, disk materialization,
// persistence) end to end, not just the protocol in isolation.
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VaultClient } from '../src/client'

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms))
const silent = () => {}
function freePort(): number {
  return 31000 + Math.floor(Math.random() * 20000)
}

async function tempVault(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'edgesync-local-'))
}

describe('VaultClient — scenarios d\'acceptation', () => {
  const clients: VaultClient[] = []
  const dirs: string[] = []

  afterEach(async () => {
    for (const c of clients) c.dispose()
    clients.length = 0
    for (const d of dirs) await rm(d, { recursive: true, force: true })
    dirs.length = 0
  })

  async function connectedPair(): Promise<{ a: VaultClient; b: VaultClient; dirA: string; dirB: string }> {
    const dirA = await tempVault()
    const dirB = await tempVault()
    dirs.push(dirA, dirB)
    const port = freePort()

    const a = await VaultClient.open({ vaultDir: dirA, log: silent })
    clients.push(a)
    await a.listen(port)

    const b = await VaultClient.open({ vaultDir: dirB, log: silent })
    clients.push(b)
    await b.dial(`ws://127.0.0.1:${port}`)
    await settle()

    return { a, b, dirA, dirB }
  }

  it('S1 — vault vide, deux pairs, election owner', async () => {
    const { a, b } = await connectedPair()
    expect(a.isOwner).toBe(true) // A ecoutait: owner (Keyring.genesis)
    expect(b.isOwner).toBe(false) // B a compose: membre, recoit la cle
    expect(a.listDocuments()).toHaveLength(0)
    expect(b.listDocuments()).toHaveLength(0)
  })

  it('S2 — creation d\'un document, propagation du contenu', async () => {
    const { a, b, dirB } = await connectedPair()
    a.createDocument('note.md', 'bonjour')
    await settle()

    const onB = b.listDocuments()
    expect(onB).toHaveLength(1)
    expect(onB[0].path).toBe('note.md')
    expect(b.documentContent(onB[0].id)).toBe('bonjour')
    expect(await readFile(join(dirB, 'note.md'), 'utf8')).toBe('bonjour')
  })

  it('S3 — edition concurrente, merge fin (aucune modification n\'ecrase l\'autre)', async () => {
    const { a, b } = await connectedPair()
    const docId = a.createDocument('note.md', 'MILIEU')
    await settle()
    const bDocId = b.listDocuments()[0].id
    expect(bDocId).toBe(docId)

    // Les deux pairs editent AVANT que la premiere sync n'ait eu lieu.
    a.insertText(docId, a.documentContent(docId)!.length, '-FIN')
    b.insertText(bDocId, 0, 'DEBUT-')
    await settle()

    expect(a.documentContent(docId)).toBe('DEBUT-MILIEU-FIN')
    expect(b.documentContent(bDocId)).toBe('DEBUT-MILIEU-FIN')
  })

  it('S4 — renommage : meme docId, contenu preserve, fichier deplace cote distant', async () => {
    const { a, b, dirB } = await connectedPair()
    const docId = a.createDocument('note.md', 'contenu')
    await settle()

    a.renameDocument(docId, 'notes/idee.md')
    await settle()

    const entry = b.listDocuments().find((e) => e.id === docId)
    expect(entry?.path).toBe('notes/idee.md')
    expect(await readFile(join(dirB, 'notes/idee.md'), 'utf8')).toBe('contenu')
    await expect(readFile(join(dirB, 'note.md'), 'utf8')).rejects.toThrow()
  })

  it('S5 — suppression : disparait cote distant, fichier efface', async () => {
    const { a, b, dirB } = await connectedPair()
    const docId = a.createDocument('note.md', 'contenu')
    await settle()
    expect(b.listDocuments()).toHaveLength(1)

    a.deleteDocument(docId)
    await settle()

    expect(b.listDocuments()).toHaveLength(0)
    await expect(readFile(join(dirB, 'note.md'), 'utf8')).rejects.toThrow()
  })

  it('S6 — redemarrage : meme identite, meme trousseau, contenu coherent', async () => {
    const dirA = await tempVault()
    dirs.push(dirA)
    const port1 = freePort()

    const a1 = await VaultClient.open({ vaultDir: dirA, log: silent })
    await a1.listen(port1)
    const docId = a1.createDocument('note.md', 'avant redemarrage')
    await settle()
    await a1.persist()
    const fingerprintBefore = a1.identityFingerprint
    a1.dispose()

    const a2 = await VaultClient.open({ vaultDir: dirA, log: silent })
    clients.push(a2)
    expect(a2.identityFingerprint).toBe(fingerprintBefore) // meme identite
    expect(a2.listDocuments()).toHaveLength(1) // meme trousseau/repertoire
    expect(a2.documentContent(docId)).toBe('avant redemarrage') // contenu coherent

    // reconnexion effective, pas seulement l'etat local
    const port2 = freePort()
    await a2.listen(port2)
    expect(a2.isGranting).toBe(true) // K_vault deja possede avant meme la reconnexion
  })
})
