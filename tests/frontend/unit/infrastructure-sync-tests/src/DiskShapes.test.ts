// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Tous les documents ont un fichier lisible sur le disque : un texte CRDT
// (.tex) dans les deux sens, un arbre CRDT (carte mentale) en JSON.
import { describe, it, expect, afterEach } from 'vitest'
import { FileSystemVaultSession, type YjsCrdtAdapter } from '@savoire/infrastructure-sync'
import { DocumentStore, InMemoryVaultFileSystem, VaultClient, type IVaultStorage } from '@savoire/platform'

const until = async (cond: () => Promise<boolean>, ms = 3000) => {
  const end = Date.now() + ms
  while (!(await cond().catch(() => false))) { if (Date.now() > end) throw new Error('jamais'); await new Promise(r => setTimeout(r, 10)) }
}

describe('fichiers lisibles sur le disque', () => {
  const sessions: FileSystemVaultSession[] = []
  afterEach(async () => { for (const s of sessions.splice(0)) await s.dispose() })

  async function setup() {
    const fs = new InMemoryVaultFileSystem()
    const s = await FileSystemVaultSession.open(fs, { vaultId: 'v', token: '', userId: 'a', onChanged: () => {} }, {
      persistMs: 5, projectMs: 5, scanMs: 5,
      isTextDocument: p => /\.(md|tex)$/.test(p),
      isTreeDocument: p => p.endsWith('.mm'),
    })
    sessions.push(s)
    const fail = async (): Promise<never> => { throw new Error('x') }
    const client = new VaultClient('v', '', { readFile: fail, writeFile: fail, resolveFileUrl: () => '', listDocuments: fail, uploadAttachment: fail } as IVaultStorage,
      new DocumentStore({ getDocumentContent: fail, writeDocumentContent: fail }), s.directory, () => undefined, s, p => (/\.(md|tex|mm)$/.test(p) ? 'crdt' : 'snapshot'))
    return { fs, s, client }
  }

  it('un .tex : le fichier suit le texte, et une modification faite ailleurs revient', async () => {
    const { fs, s, client } = await setup()
    await client.createFile('a.tex')
    const id = client.resolveDocumentId('a.tex')!
    const crdt = s.openDocument(id) as YjsCrdtAdapter
    crdt.sharedText().insert(0, '\\section{Un}')
    await until(async () => (await fs.readText('a.tex')) === '\\section{Un}')
    await fs.writeText('a.tex', '\\section{Deux}')
    await until(async () => crdt.sharedText().toString() === '\\section{Deux}')
    s.closeDocument(id)
  })

  it('une carte mentale : son arbre en JSON dans le fichier', async () => {
    const { fs, s, client } = await setup()
    await client.createFile('carte.mm')
    const id = client.resolveDocumentId('carte.mm')!
    const crdt = s.openDocument(id) as YjsCrdtAdapter
    const tree = crdt.sharedTree()
    tree.root.set('titre', 'Idees')
    await until(async () => (await fs.readText('carte.mm')).includes('"titre": "Idees"'))
    expect(JSON.parse(await fs.readText('carte.mm'))).toEqual({ savoire: 'tree', tree: { titre: 'Idees' } })
    s.closeDocument(id)
  })
})

describe('fichier d arbre venu d un autre logiciel', () => {
  it('n est jamais ecrase', async () => {
    const fs = new InMemoryVaultFileSystem()
    await fs.writeText('dessin.mm', '{"type":"excalidraw","elements":[]}')
    const s = await FileSystemVaultSession.open(fs, { vaultId: 'v', token: '', userId: 'a', onChanged: () => {} }, {
      persistMs: 5, projectMs: 5, scanMs: 5, isTreeDocument: p => p.endsWith('.mm'),
    })
    const id = s.directory.getAll().find(d => d.path === 'dessin.mm')!.id
    const crdt = s.openDocument(id) as YjsCrdtAdapter
    crdt.sharedTree().root.set('x', 1)
    await new Promise(r => setTimeout(r, 150))
    expect(await fs.readText('dessin.mm')).toBe('{"type":"excalidraw","elements":[]}')
    s.closeDocument(id)
    await s.dispose()
  })
})
