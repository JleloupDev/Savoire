// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Connexion a Notion depuis le bureau (ADR-035) : le parcours d'autorisation,
// et l'ecriture de l'import dans le vault ouvert.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InMemorySharedTree } from '@savoire/plugin-runtime'
import { readManifest } from '@savoire/plugin-base'
import { connectError, desktopNotion, pkceChallenge } from '../../../../../apps/web/src/notionConnection'
import { localImportStore, pluginApiTarget, reportText } from '../../../../../apps/web/src/notionImport'

function tauri(handlers: Record<string, (args?: Record<string, unknown>) => unknown>) {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = []
  const scope = {
    isTauri: true,
    __TAURI_INTERNALS__: {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args })
        const h = handlers[cmd]
        if (!h) throw new Error(`commande inconnue : ${cmd}`)
        return h(args)
      },
    },
  }
  return { scope, calls }
}

beforeEach(() => { localStorage.clear() })

describe('connexion a Notion', () => {
  it('hors bureau : pas de pont', () => {
    expect(desktopNotion({})).toBeNull()
  })

  it('ouvre l\'autorisation du serveur, verifie l\'etat, remet ticket et verifier a Rust', async () => {
    let opened = ''
    const { scope, calls } = tauri({
      oauth_listen: () => 54321,
      open_external: (a) => { opened = String(a!.url); return null },
      oauth_wait: () => {
        const u = new URL(opened)
        return `ticket=T1&state=${u.searchParams.get('state')}`
      },
      notion_connect: () => ({ workspaceId: 'w', workspaceName: 'Mon espace', workspaceIcon: null }),
    })
    const ws = await desktopNotion(scope)!.connect()
    expect(ws.workspaceName).toBe('Mon espace')
    const u = new URL(opened)
    expect(u.pathname).toBe('/api/v1/notion/authorize')
    expect(u.searchParams.get('port')).toBe('54321')
    const connect = calls.find(c => c.cmd === 'notion_connect')!.args!
    expect(connect.ticket).toBe('T1')
    expect(connect.state).toBe(u.searchParams.get('state'))
    // Le defi envoye est celui du verifier remis a Rust.
    expect(await pkceChallenge(String(connect.verifier))).toBe(u.searchParams.get('challenge'))
  })

  it('refuse un retour dont l\'etat ne correspond pas', async () => {
    const { scope } = tauri({
      oauth_listen: () => 1234,
      open_external: () => null,
      oauth_wait: () => 'ticket=T1&state=autre',
    })
    await expect(desktopNotion(scope)!.connect()).rejects.toThrow(/inattendue/)
  })

  it('dit en clair un refus de Notion', () => {
    expect(connectError(new URLSearchParams('error=access_denied'))).toBe('Autorisation annulée dans Notion.')
    expect(connectError(new URLSearchParams('error=exchange_failed&error_description=code%20expir%C3%A9'))).toContain('code expiré')
    expect(connectError(new URLSearchParams('ticket=x'))).toBeNull()
  })

  it('les appels a l\'API passent par notion_api, corps en JSON', async () => {
    const { scope, calls } = tauri({ notion_api: () => ({ status: 200, body: '{}' }) })
    await desktopNotion(scope)!.api.request('POST', '/v1/search', { page_size: 100 })
    expect(calls[0]).toEqual({ cmd: 'notion_api', args: { method: 'POST', path: '/v1/search', body: '{"page_size":100}' } })
  })
})

describe('ecriture dans le vault ouvert', () => {
  function fakeApi() {
    const docs = new Map<string, string>()
    const trees = new Map<string, InMemorySharedTree>()
    const texts = new Map<string, string>()
    const props = new Map<string, unknown>()
    const api = {
      vault: {
        resolveDocumentId: (p: string) => docs.get(p) ?? null,
        getFileTree: () => [...docs.entries()].map(([path, docId]) => ({ path, docId })),
        createFolder: vi.fn(async () => {}),
        createFile: async (p: string) => { docs.set(p, `id-${docs.size + 1}`) },
        openTree: async (id: string) => { const t = trees.get(id) ?? new InMemorySharedTree(); trees.set(id, t); return t },
        closeTree: vi.fn(),
        editText: async (id: string, edit: (c: string) => string) => { texts.set(id, edit(texts.get(id) ?? '')); return true },
        write: vi.fn(),
        uploadAttachment: vi.fn(async (file: File, o: { notePath?: string }) => `${o.notePath!.replace(/\.page$/, '')}/${file.name}`),
      },
      properties: { get: (k: string) => props.get(k), set: (d: { key: string }) => { props.set(d.key, d) } },
    }
    return { api, docs, trees, texts, props }
  }

  it('cree, remplit une page et une base, enregistre un fichier, garde les types deja choisis', async () => {
    const f = fakeApi()
    f.props.set('Statut', { key: 'Statut', type: 'text' })
    const target = pluginApiTarget(f.api as never)
    const pageId = await target.createDocument('N/Accueil.page')
    await target.writePage(pageId, { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Bonjour' }] }] })
    expect(f.trees.get(pageId)!.root.get('doc')).toBeTruthy()
    expect(f.api.vault.closeTree).toHaveBeenCalledWith(pageId)

    const baseId = await target.createDocument('N/Tâches.base')
    await target.writeBase(baseId, {
      columns: [{ key: 'Statut', width: 200, order: 1 }],
      views: [{ id: 'v1', name: 'Kanban', type: 'kanban', order: 0, filters: [], sorts: [], groupBy: 'Statut', hidden: [], totals: {} }],
      warnings: [],
    }, 'N/Tâches')
    const m = readManifest(f.trees.get(baseId), 'N/Tâches')
    expect(m.stored).toBe(true)
    expect(m.source.folder).toBe('N/Tâches')
    expect(m.columns.map(c => [c.key, c.width])).toEqual([['Statut', 200]])
    expect(m.views[0]).toMatchObject({ name: 'Kanban', type: 'kanban', groupBy: 'Statut' })

    const noteId = await target.createDocument('N/Tâches/Logo.md')
    await target.writeNote(noteId, '---\nStatut: Fait\n---\n')
    expect(f.texts.get(noteId)).toBe('---\nStatut: Fait\n---\n')

    expect(await target.writeAttachment('N/Accueil.page', 'logo.png', new Uint8Array([1]))).toBe('N/Accueil/logo.png')
    target.declareProperties([{ key: 'Statut', type: 'select' }, { key: 'Prix', type: 'number' }])
    expect(f.props.get('Statut')).toEqual({ key: 'Statut', type: 'text' })
    expect(f.props.get('Prix')).toEqual({ key: 'Prix', type: 'number' })
    expect(target.exists('N')).toBe(true)
    expect(target.exists('N/Autre.page')).toBe(false)
  })

  it('n\'ecrit plus rien une fois le vault change', async () => {
    const f = fakeApi()
    let changed = false
    const target = pluginApiTarget(f.api as never, () => { if (changed) throw new Error('Le vault a changé') })
    changed = true
    await expect(target.createDocument('N/A.page')).rejects.toThrow(/vault a changé/)
    expect(f.docs.size).toBe(0)
  })

  it('garde l\'etat d\'un import par vault, sur ce poste', async () => {
    const a = localImportStore('vault-a')
    await a.save({ version: 1, root: 'N', workspace: 'N', startedAt: 'x', items: {}, aliases: {}, warnings: [], unsupported: {}, files: 0 })
    expect((await a.load())?.root).toBe('N')
    expect(await localImportStore('vault-b').load()).toBeNull()
  })

  it('resume le rapport', () => {
    expect(reportText({ pages: 3, bases: 1, rows: 4, files: 2, failed: [], warnings: [], unsupported: { ai_block: 2 } }))
      .toBe('3 page(s), 1 base(s), 4 ligne(s), 2 fichier(s). 2 bloc(s) non importé(s).')
  })
})
