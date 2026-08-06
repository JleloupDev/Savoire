// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// EdgesyncVaultSession: the vault-scoped composition root replacing the old
// per-document independent-Keyring model (EdgesyncDocSession). Proves the
// owner rule, that vault directory + documents share one Keyring, and — the
// critical regression case — that a document opened well after the vault
// connection is already up (the normal case here: a document is only opened
// once its editor panel mounts) still converges, exercising the same
// HELLO-retry fix proven in poc/edgesync-local-client.
import { describe, it, expect, vi } from 'vitest'
import * as Y from 'yjs'
import {
  EdgesyncVaultSession, EdgesyncRelayTransport, EdgesyncWebRtcTransport, YMapVaultDirectory,
  WrongVaultKeyError, type KeyringSource,
} from '@savoire/infrastructure-sync'
import { randomBytes, InMemoryStorage, Keyring } from 'edgesync-protocol'
import { FakeRelayServer } from './fakeRelay'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Y_ = Y as Record<string, any>

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms))

/** In-memory stand-in for VaultKeyEscrow — tests EdgesyncVaultSession's own
 *  behaviour (skip genesis when restored, escrow after genesis/grant)
 *  without exercising VaultKeyEscrow's HTTP/crypto specifics (see
 *  VaultKeyEscrow.test.ts for those). */
// Snapshots via serialize()/deserialize() rather than storing the Keyring
// object itself — Keyring is mutable, so storing it by reference would let a
// caller's later in-place mutation (e.g. mintDocKey) "reach" a save() that
// was never actually called, masking bugs the real HTTP-backed VaultKeyEscrow
// (which genuinely serializes at the wire boundary) would not mask.
function fakeKeyEscrow(): KeyringSource & { store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>()
  return {
    store,
    fetch: async (vaultId: string) => {
      const bytes = store.get(vaultId)
      return bytes ? Keyring.deserialize(bytes) : undefined
    },
    save: async (vaultId: string, keyring: Keyring) => { store.set(vaultId, keyring.serialize()) },
  }
}

function openOn(server: FakeRelayServer, directory: YMapVaultDirectory, vaultId = 'vault-1') {
  const transport = new EdgesyncWebRtcTransport({ relay: new EdgesyncRelayTransport({ connection: server.attach() }) })
  return EdgesyncVaultSession.open({
    vaultId,
    identitySeed: randomBytes(32),
    directory,
    transport,
  })
}

describe('EdgesyncVaultSession — slice vault + documents partagent une cle', () => {
  it('regle owner : premier connecte = detenteur de cle ; suivant = non', async () => {
    const server = new FakeRelayServer()
    const first = await openOn(server, new YMapVaultDirectory())
    const second = await openOn(server, new YMapVaultDirectory())

    expect(first.isOwner).toBe(true)
    expect(second.isOwner).toBe(false)

    first.dispose(); second.dispose()
  })

  it('create()/join() explicites (sans claimOwner) : le createur mint, le joiner recoit et converge', async () => {
    const server = new FakeRelayServer()
    const dirA = new YMapVaultDirectory()
    const dirB = new YMapVaultDirectory()

    // No claimOwner involved at all here — this is the S1/S4 shape (caller
    // already knows who's founding vs joining, e.g. a human action), proven
    // standalone from the S2/S3 open() convenience wrapper above.
    const a = await EdgesyncVaultSession.create({
      vaultId: 'vault-2', identitySeed: randomBytes(32), directory: dirA,
      transport: new EdgesyncWebRtcTransport({ relay: new EdgesyncRelayTransport({ connection: server.attach() }) }),
    })
    const b = await EdgesyncVaultSession.join({
      vaultId: 'vault-2', identitySeed: randomBytes(32), directory: dirB,
      transport: new EdgesyncWebRtcTransport({ relay: new EdgesyncRelayTransport({ connection: server.attach() }) }),
    })

    expect(a.isOwner).toBe(true)
    expect(b.isOwner).toBe(false)

    dirA.add({ id: 'doc-1', path: 'note.md' })
    await settle()
    expect(dirB.getById('doc-1')?.path).toBe('note.md')

    a.dispose(); b.dispose()
  })

  it('deux connexions vraiment concurrentes (Promise.all, room vide des deux cotes) : un seul owner, pas de cle scindee', async () => {
    const server = new FakeRelayServer()
    const dirA = new YMapVaultDirectory()
    const dirB = new YMapVaultDirectory()

    // Both call open() without awaiting each other first — the exact race that
    // used to let both self-elect via "peers().length === 0". ClaimOwner on
    // the (fake) relay hub arbitrates atomically instead.
    const [a, b] = await Promise.all([openOn(server, dirA), openOn(server, dirB)])

    expect([a.isOwner, b.isOwner].filter(Boolean)).toHaveLength(1)

    dirA.add({ id: 'doc-1', path: 'note.md' })
    await settle()
    expect(dirB.getById('doc-1')?.path).toBe('note.md')

    a.dispose(); b.dispose()
  })

  it('le repertoire du vault converge (note list) via le canal partage', async () => {
    const server = new FakeRelayServer()
    const dirA = new YMapVaultDirectory()
    const dirB = new YMapVaultDirectory()
    const a = await openOn(server, dirA)
    const b = await openOn(server, dirB)
    await settle()

    dirA.add({ id: 'doc-1', path: 'note.md' })
    await settle()

    expect(dirB.getById('doc-1')?.path).toBe('note.md')

    a.dispose(); b.dispose()
  })

  it('un document deja liste au moment de la connexion converge (champ codemirror)', async () => {
    const server = new FakeRelayServer()
    const dirA = new YMapVaultDirectory()
    dirA.add({ id: 'doc-1', path: 'note.md' })
    const dirB = new YMapVaultDirectory()

    const a = await openOn(server, dirA)
    const b = await openOn(server, dirB)
    await settle()

    const docA = new Y_.Doc()
    docA.getText('codemirror').insert(0, 'contenu initial')
    a.openDocument('doc-1', docA)

    // B learns about doc-1 via the directory sync above, then opens it too.
    await settle()
    expect(dirB.getById('doc-1')?.path).toBe('note.md')
    const docB = new Y_.Doc()
    b.openDocument('doc-1', docB)
    await settle(400)

    expect(docB.getText('codemirror').toString()).toBe('contenu initial')

    a.dispose(); b.dispose()
  })

  it('un document ouvert APRES coup (connexion deja active) converge quand meme — regression HELLO', async () => {
    const server = new FakeRelayServer()
    const dirA = new YMapVaultDirectory()
    const dirB = new YMapVaultDirectory()
    const a = await openOn(server, dirA)
    const b = await openOn(server, dirB)
    await settle() // both peers fully connected, directory-keyed, BEFORE any document exists

    const docA = new Y_.Doc()
    dirA.add({ id: 'doc-1', path: 'note.md' }) // created live, well after connection
    a.openDocument('doc-1', docA)
    docA.getText('codemirror').insert(0, 'ecrit apres connexion')

    await settle()
    expect(dirB.getById('doc-1')?.path).toBe('note.md')
    const docB = new Y_.Doc()
    b.openDocument('doc-1', docB)

    // Give the HELLO_RETRY_DELAYS_MS window room to bridge the race.
    await settle(1200)

    expect(docB.getText('codemirror').toString()).toBe('ecrit apres connexion')

    a.dispose(); b.dispose()
  })

  it('un document ouvert bien APRES la fenetre de retry de A recoit quand meme le contenu deja ecrit (pas de dependance au hasard du timing — regression contenu perdu)', async () => {
    const server = new FakeRelayServer()
    const dirA = new YMapVaultDirectory()
    const dirB = new YMapVaultDirectory()
    const a = await openOn(server, dirA)
    const b = await openOn(server, dirB)
    await settle()

    const docA = new Y_.Doc()
    dirA.add({ id: 'doc-1', path: 'note.md' })
    a.openDocument('doc-1', docA)
    docA.getText('codemirror').insert(0, 'ecrit bien avant')

    // Let A's own HELLO_RETRY_DELAYS_MS window (up to 750ms after A opened
    // the document) fully elapse BEFORE B ever shows interest — the
    // realistic case (B opens the note seconds/minutes later, not within
    // A's narrow retry burst). The other "regression HELLO" test above only
    // passes because B happens to open within that window, letting one of
    // A's own late retries reach B's freshly-created Session — a timing
    // coincidence, not a real fix.
    await settle(1000)
    expect(dirB.getById('doc-1')?.path).toBe('note.md')

    const docB = new Y_.Doc()
    b.openDocument('doc-1', docB)
    await settle(1200)

    expect(docB.getText('codemirror').toString()).toBe('ecrit bien avant')

    a.dispose(); b.dispose()
  }, 10000)

  it('edition cote B converge vers A (bidirectionnel)', async () => {
    const server = new FakeRelayServer()
    const dirA = new YMapVaultDirectory()
    const dirB = new YMapVaultDirectory()
    const a = await openOn(server, dirA)
    const b = await openOn(server, dirB)
    await settle()

    const docA = new Y_.Doc()
    dirA.add({ id: 'doc-1', path: 'note.md' })
    a.openDocument('doc-1', docA)
    await settle()
    const docB = new Y_.Doc()
    b.openDocument('doc-1', docB)
    await settle(400)

    docB.getText('codemirror').insert(0, 'depuis B')
    await settle(300)

    expect(docA.getText('codemirror').toString()).toBe('depuis B')

    a.dispose(); b.dispose()
  })

  it('presence (curseur pair) : un changement local cote A declenche applyRemotePresence cote B', async () => {
    const server = new FakeRelayServer()
    const dirA = new YMapVaultDirectory()
    const dirB = new YMapVaultDirectory()
    const a = await openOn(server, dirA)
    const b = await openOn(server, dirB)
    await settle()

    const docA = new Y_.Doc()
    dirA.add({ id: 'doc-1', path: 'note.md' })
    let localChangeCbA: ((bytes: Uint8Array, changed: number[]) => void) | undefined
    const presenceA = {
      onLocalPresenceChanged: vi.fn((cb: (bytes: Uint8Array, changed: number[]) => void) => {
        localChangeCbA = cb
        return () => { localChangeCbA = undefined }
      }),
      applyRemotePresence: vi.fn(),
    }
    a.openDocument('doc-1', docA, presenceA)

    const docB = new Y_.Doc()
    const presenceB = { onLocalPresenceChanged: vi.fn(() => () => {}), applyRemotePresence: vi.fn() }
    await settle()
    b.openDocument('doc-1', docB, presenceB)
    await settle(400)

    // Simulate a local cursor move on A: fire the callback EdgesyncVaultSession
    // registered through presenceA.onLocalPresenceChanged.
    localChangeCbA?.(new Uint8Array([7, 7, 7]), [1])
    await settle()

    expect(presenceB.applyRemotePresence).toHaveBeenCalledWith(new Uint8Array([7, 7, 7]))

    a.dispose(); b.dispose()
  })

  it('presence : closeDocument() puis dispose() nettoient le canal awareness sans jeter', async () => {
    const server = new FakeRelayServer()
    const dirA = new YMapVaultDirectory()
    const a = await openOn(server, dirA)
    await settle()

    const docA = new Y_.Doc()
    dirA.add({ id: 'doc-1', path: 'note.md' })
    const unsubLocal = vi.fn()
    const presenceA = { onLocalPresenceChanged: vi.fn(() => unsubLocal), applyRemotePresence: vi.fn() }
    a.openDocument('doc-1', docA, presenceA)

    expect(() => a.closeDocument('doc-1')).not.toThrow()
    expect(unsubLocal).toHaveBeenCalledOnce()

    await expect(a.dispose()).resolves.toBeUndefined()
  })

  it('presence : un remount (openDocument rappele sur un canal deja ouvert) cable quand meme la presence (regression: React StrictMode)', async () => {
    const server = new FakeRelayServer()
    const dirA = new YMapVaultDirectory()
    const a = await openOn(server, dirA)
    await settle()

    const docA = new Y_.Doc()
    dirA.add({ id: 'doc-1', path: 'note.md' })

    // First call WITHOUT presence (e.g. a first render before the CRDT
    // adapter is ready) — the channel exists, but nothing is wired yet.
    a.openDocument('doc-1', docA)

    let localChangeCb: ((bytes: Uint8Array, changed: number[]) => void) | undefined
    const presenceA = {
      onLocalPresenceChanged: vi.fn((cb: (bytes: Uint8Array, changed: number[]) => void) => {
        localChangeCb = cb
        return () => { localChangeCb = undefined }
      }),
      applyRemotePresence: vi.fn(),
    }
    // Remount: openDocument called AGAIN for the same docId, this time with
    // presence — must not be skipped by the "already open" early return.
    const session2 = a.openDocument('doc-1', docA, presenceA)
    expect(session2).toBeDefined()

    expect(presenceA.onLocalPresenceChanged).toHaveBeenCalledOnce()
    expect(localChangeCb).toBeDefined()

    a.dispose()
  })

  it('index (curseurs/entrees derivees) : ouvert des deux cotes des le depart, converge', async () => {
    const server = new FakeRelayServer()
    const a = await openOn(server, new YMapVaultDirectory())
    const b = await openOn(server, new YMapVaultDirectory())
    await settle()

    const idxA = a.openIndex('hashtags')
    const idxB = b.openIndex('hashtags')
    await settle()

    idxA.set('hashtags|doc-1|a|b', { value: '#salut', docId: 'doc-1' })
    await settle()

    expect(idxB.get('hashtags|doc-1|a|b')).toEqual({ value: '#salut', docId: 'doc-1' })

    a.dispose(); b.dispose()
  })

  it('index ouvert bien APRES la fenetre de retry de A recoit quand meme les entrees deja ecrites (meme regression que les documents, meme fix)', async () => {
    const server = new FakeRelayServer()
    const a = await openOn(server, new YMapVaultDirectory())
    const b = await openOn(server, new YMapVaultDirectory())
    await settle()

    const idxA = a.openIndex('wikilinks')
    idxA.set('wikilinks|doc-1|x|y', { value: 'Target Page', docId: 'doc-1' })

    // Let A's own HELLO_RETRY_DELAYS_MS window (up to 750ms) fully elapse
    // before B ever opens the same namespace — same race as the document
    // regression test, proven fixed by the same Session.onHello echo.
    await settle(1000)

    const idxB = b.openIndex('wikilinks')
    await settle(1200)

    expect(idxB.get('wikilinks|doc-1|x|y')).toEqual({ value: 'Target Page', docId: 'doc-1' })

    a.dispose(); b.dispose()
  }, 10000)

  it('index : edition cote B converge vers A (bidirectionnel), namespaces distincts isoles', async () => {
    const server = new FakeRelayServer()
    const a = await openOn(server, new YMapVaultDirectory())
    const b = await openOn(server, new YMapVaultDirectory())
    await settle()

    const hashtagsA = a.openIndex('hashtags')
    const graphA = a.openIndex('graph')
    const hashtagsB = b.openIndex('hashtags')
    await settle(400)

    hashtagsB.set('hashtags|doc-2|p|q', { value: '#depuisB', docId: 'doc-2' })
    graphA.set('graph|doc-3', { nodes: ['doc-3'] })
    await settle(300)

    expect(hashtagsA.get('hashtags|doc-2|p|q')).toEqual({ value: '#depuisB', docId: 'doc-2' })
    // B never opened 'graph': its own channel for that namespace doesn't exist,
    // and it must not leak into the 'hashtags' channel it does have open.
    expect(hashtagsB.getAll().some((e) => e.id === 'graph|doc-3')).toBe(false)

    a.dispose(); b.dispose()
  })

  it('index : closeIndex() puis dispose() nettoient sans jeter', async () => {
    const server = new FakeRelayServer()
    const a = await openOn(server, new YMapVaultDirectory())
    await settle()

    a.openIndex('hashtags')
    expect(() => a.closeIndex('hashtags')).not.toThrow()
    expect(() => a.closeIndex('hashtags')).not.toThrow() // second call is a no-op, not a throw

    a.openIndex('graph')
    await expect(a.dispose()).resolves.toBeUndefined()
  })
})

describe('EdgesyncVaultSession — keyEscrow (recuperation du Keyring)', () => {
  it('open() escrow le Keyring apres une genesis fraiche, puis le restaure et ne rappelle jamais claimOwner', async () => {
    const server = new FakeRelayServer()
    const keyEscrow = fakeKeyEscrow()

    const transport1 = new EdgesyncWebRtcTransport({ relay: new EdgesyncRelayTransport({ connection: server.attach() }) })
    const a1 = await EdgesyncVaultSession.open({
      vaultId: 'vault-escrow', identitySeed: randomBytes(32), directory: new YMapVaultDirectory(),
      keyEscrow, transport: transport1,
    })
    expect(a1.isOwner).toBe(true) // room was empty — claimOwner elects it
    expect(keyEscrow.store.has('vault-escrow')).toBe(true) // saved synchronously inside finalize()
    await a1.dispose()

    const transport2 = new EdgesyncWebRtcTransport({ relay: new EdgesyncRelayTransport({ connection: server.attach() }) })
    const claimOwnerSpy = vi.spyOn(transport2, 'claimOwner')
    const a2 = await EdgesyncVaultSession.open({
      vaultId: 'vault-escrow', identitySeed: randomBytes(32), directory: new YMapVaultDirectory(),
      keyEscrow, transport: transport2,
    })

    expect(claimOwnerSpy).not.toHaveBeenCalled() // known member — no re-election
    expect(a2.isOwner).toBe(false) // restored sessions never claim isOwner=true — see class doc comment

    await a2.dispose()
  })

  it('create()/join() restaurent aussi via keyEscrow quand il connait deja le vault', async () => {
    const server = new FakeRelayServer()
    const keyEscrow = fakeKeyEscrow()

    const a1 = await EdgesyncVaultSession.create({
      vaultId: 'vault-restore-create', identitySeed: randomBytes(32), directory: new YMapVaultDirectory(),
      keyEscrow, transport: new EdgesyncWebRtcTransport({ relay: new EdgesyncRelayTransport({ connection: server.attach() }) }),
    })
    await a1.dispose()

    // Re-open with join() this time — the caller's own choice is irrelevant
    // once keyEscrow already knows this vault.
    const a2 = await EdgesyncVaultSession.join({
      vaultId: 'vault-restore-create', identitySeed: randomBytes(32), directory: new YMapVaultDirectory(),
      keyEscrow, transport: new EdgesyncWebRtcTransport({ relay: new EdgesyncRelayTransport({ connection: server.attach() }) }),
    })
    expect(a2.isOwner).toBe(false)

    await a2.dispose()
  })

  it('un joiner qui recoit le grant en direct escrow sa PROPRE copie (chiffree sous SON K_User)', async () => {
    const server = new FakeRelayServer()
    const keyEscrowA = fakeKeyEscrow()
    const keyEscrowB = fakeKeyEscrow()

    const a = await EdgesyncVaultSession.open({
      vaultId: 'vault-joiner-escrow', identitySeed: randomBytes(32), directory: new YMapVaultDirectory(),
      keyEscrow: keyEscrowA, transport: new EdgesyncWebRtcTransport({ relay: new EdgesyncRelayTransport({ connection: server.attach() }) }),
    })
    const b = await EdgesyncVaultSession.open({
      vaultId: 'vault-joiner-escrow', identitySeed: randomBytes(32), directory: new YMapVaultDirectory(),
      keyEscrow: keyEscrowB, transport: new EdgesyncWebRtcTransport({ relay: new EdgesyncRelayTransport({ connection: server.attach() }) }),
    })

    // Give the HELLO_RETRY_DELAYS_MS window (up to 750ms) time to both grant
    // B live AND fire the opportunistic escrow-on-grant check in finalize().
    await settle(1000)

    expect(keyEscrowB.store.has('vault-joiner-escrow')).toBe(true)

    a.dispose(); b.dispose()
  })

  it('restore() propage WrongVaultKeyError sans l\'attraper (mauvaise cle != rien trouve)', async () => {
    const server = new FakeRelayServer()
    const throwingEscrow: KeyringSource = {
      fetch: async () => { throw new WrongVaultKeyError('vault-wrong-key') },
      save: async () => {},
    }

    await expect(EdgesyncVaultSession.open({
      vaultId: 'vault-wrong-key', identitySeed: randomBytes(32), directory: new YMapVaultDirectory(),
      keyEscrow: throwingEscrow,
      transport: new EdgesyncWebRtcTransport({ relay: new EdgesyncRelayTransport({ connection: server.attach() }) }),
    })).rejects.toThrow(WrongVaultKeyError)
  })
})

describe('EdgesyncVaultSession — persistance du contenu (IStorage)', () => {
  it('contenu (repertoire + document) restaure apres reload — storage (contenu) + keyEscrow (cle) combines', async () => {
    const server = new FakeRelayServer()
    const storage = new InMemoryStorage()
    const keyEscrow = fakeKeyEscrow()
    const dir1 = new YMapVaultDirectory()
    const a1 = await EdgesyncVaultSession.open({
      vaultId: 'vault-content', identitySeed: randomBytes(32), directory: dir1, storage, keyEscrow,
      transport: new EdgesyncWebRtcTransport({ relay: new EdgesyncRelayTransport({ connection: server.attach() }) }),
    })
    dir1.add({ id: 'doc-1', path: 'note.md' })
    const doc1 = new Y_.Doc()
    doc1.getText('codemirror').insert(0, 'contenu solo')
    a1.openDocument('doc-1', doc1)
    await settle()
    await a1.dispose() // flushes the debounced persist()

    const dir2 = new YMapVaultDirectory()
    const a2 = await EdgesyncVaultSession.open({
      vaultId: 'vault-content', identitySeed: randomBytes(32), directory: dir2, storage, keyEscrow,
      transport: new EdgesyncWebRtcTransport({ relay: new EdgesyncRelayTransport({ connection: server.attach() }) }),
    })
    await settle(50) // let finalize()'s fire-and-forget loadContent() resolve
    expect(dir2.getById('doc-1')?.path).toBe('note.md')

    const doc2 = new Y_.Doc()
    a2.openDocument('doc-1', doc2)
    await settle(50)
    expect(doc2.getText('codemirror').toString()).toBe('contenu solo')

    await a2.dispose()
  })

  it('contenu d\'un index restaure apres reload', async () => {
    const server = new FakeRelayServer()
    const storage = new InMemoryStorage()
    const keyEscrow = fakeKeyEscrow()
    const a1 = await EdgesyncVaultSession.open({
      vaultId: 'vault-index-restore', identitySeed: randomBytes(32), directory: new YMapVaultDirectory(), storage, keyEscrow,
      transport: new EdgesyncWebRtcTransport({ relay: new EdgesyncRelayTransport({ connection: server.attach() }) }),
    })
    const idx1 = a1.openIndex('hashtags')
    idx1.set('hashtags|doc-1|a|b', { value: '#solo', docId: 'doc-1' })
    await settle()
    await a1.dispose()

    const a2 = await EdgesyncVaultSession.open({
      vaultId: 'vault-index-restore', identitySeed: randomBytes(32), directory: new YMapVaultDirectory(), storage, keyEscrow,
      transport: new EdgesyncWebRtcTransport({ relay: new EdgesyncRelayTransport({ connection: server.attach() }) }),
    })
    const idx2 = a2.openIndex('hashtags')
    await settle(50)
    expect(idx2.get('hashtags|doc-1|a|b')).toEqual({ value: '#solo', docId: 'doc-1' })

    await a2.dispose()
  })

  it('persist() est debounce : plusieurs modifications rapprochees ne declenchent qu\'une seule sauvegarde', async () => {
    const server = new FakeRelayServer()
    const storage = new InMemoryStorage()
    const dir = new YMapVaultDirectory()
    const a = await EdgesyncVaultSession.open({
      vaultId: 'vault-debounce', identitySeed: randomBytes(32), directory: dir, storage,
      transport: new EdgesyncWebRtcTransport({ relay: new EdgesyncRelayTransport({ connection: server.attach() }) }),
    })
    const setSpy = vi.spyOn(storage, 'set')
    setSpy.mockClear()

    // Three changes within the 500ms debounce window must coalesce into one
    // persist() cycle — identity + keyring + peers + the directory channel,
    // i.e. exactly 4 storage.set() calls, not 12 (3 changes x 4 calls each).
    dir.add({ id: 'doc-1', path: 'a.md' })
    dir.add({ id: 'doc-2', path: 'b.md' })
    dir.add({ id: 'doc-3', path: 'c.md' })
    await settle(50)
    expect(setSpy).not.toHaveBeenCalled()

    await settle(600)
    expect(setSpy.mock.calls.length).toBe(4)

    await settle(600) // no further changes — must not fire again
    expect(setSpy.mock.calls.length).toBe(4)

    await a.dispose()
  })

  it('dispose() flush le persist() en attente meme si le debounce n\'a pas encore expire', async () => {
    const server = new FakeRelayServer()
    const storage = new InMemoryStorage()
    const keyEscrow = fakeKeyEscrow()
    const dir = new YMapVaultDirectory()
    const a = await EdgesyncVaultSession.open({
      vaultId: 'vault-flush', identitySeed: randomBytes(32), directory: dir, storage, keyEscrow,
      transport: new EdgesyncWebRtcTransport({ relay: new EdgesyncRelayTransport({ connection: server.attach() }) }),
    })

    dir.add({ id: 'doc-1', path: 'a.md' })
    await a.dispose() // immediately after — well inside the 500ms debounce window

    const dir2 = new YMapVaultDirectory()
    const a2 = await EdgesyncVaultSession.open({
      vaultId: 'vault-flush', identitySeed: randomBytes(32), directory: dir2, storage, keyEscrow,
      transport: new EdgesyncWebRtcTransport({ relay: new EdgesyncRelayTransport({ connection: server.attach() }) }),
    })
    await settle(50)
    expect(dir2.getById('doc-1')?.path).toBe('a.md')

    await a2.dispose()
  })
})
