// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, vi } from 'vitest'
import { WorkspaceService } from '@savoire/application'
import type { VaultClient } from '@savoire/platform'

// Minimal stub implementing only what VaultClient needs for WorkspaceService
function makeClient(): VaultClient {
  return {
    read: vi.fn(async (id: string) => `content:${id}`),
    readDocumentByPath: vi.fn(async (path: string) => `by-path:${path}`),
    write: vi.fn(async () => {}),
    list: vi.fn(async (dir?: string) => dir ? [`${dir}/a.md`] : ['a.md', 'b.md']),
    exists: vi.fn(async () => true),
    resolveDocumentId: vi.fn((path: string) => `id:${path}`),
    createFile: vi.fn(async () => {}),
    createFolder: vi.fn(async () => {}),
    renameFile: vi.fn(async () => {}),
    deleteFile: vi.fn(async () => {}),
    deleteFolder: vi.fn(async () => {}),
  } as unknown as VaultClient
}

describe('WorkspaceService', () => {
  it('createVaultProxy returns a VaultAPI object', () => {
    const svc = new WorkspaceService()
    const proxy = svc.createVaultProxy(() => undefined, () => undefined)
    expect(proxy).toBeDefined()
    expect(typeof proxy.read).toBe('function')
    expect(typeof proxy.write).toBe('function')
    expect(typeof proxy.list).toBe('function')
  })

  it('proxy.read delegates to client.read', async () => {
    const svc = new WorkspaceService()
    const client = makeClient()
    const proxy = svc.createVaultProxy(() => client, () => undefined)
    const result = await proxy.read('doc-1')
    expect(client.read).toHaveBeenCalledWith('doc-1')
    expect(result).toBe('content:doc-1')
  })

  it('proxy.read returns empty string when no client', async () => {
    const svc = new WorkspaceService()
    const proxy = svc.createVaultProxy(() => undefined, () => undefined)
    expect(await proxy.read('doc-1')).toBe('')
  })

  it('proxy.readDocumentByPath delegates to client.readDocumentByPath', async () => {
    const svc = new WorkspaceService()
    const client = makeClient()
    const proxy = svc.createVaultProxy(() => client, () => undefined)
    const result = await proxy.readDocumentByPath('notes/a.md')
    expect(client.readDocumentByPath).toHaveBeenCalledWith('notes/a.md')
    expect(result).toBe('by-path:notes/a.md')
  })

  it('proxy.readDocumentByPath returns empty string when no client', async () => {
    const svc = new WorkspaceService()
    const proxy = svc.createVaultProxy(() => undefined, () => undefined)
    expect(await proxy.readDocumentByPath('note.md')).toBe('')
  })

  it('proxy.write delegates to client.write', async () => {
    const svc = new WorkspaceService()
    const client = makeClient()
    const proxy = svc.createVaultProxy(() => client, () => undefined)
    await proxy.write('doc-1', '# New Content')
    expect(client.write).toHaveBeenCalledWith('doc-1', '# New Content')
  })

  it('proxy.write is a no-op when no client', async () => {
    const svc = new WorkspaceService()
    const proxy = svc.createVaultProxy(() => undefined, () => undefined)
    await expect(proxy.write('doc-1', 'content')).resolves.toBeUndefined()
  })

  it('proxy.list delegates to client.list', async () => {
    const svc = new WorkspaceService()
    const client = makeClient()
    const proxy = svc.createVaultProxy(() => client, () => undefined)
    const result = await proxy.list()
    expect(client.list).toHaveBeenCalledWith(undefined)
    expect(result).toEqual(['a.md', 'b.md'])
  })

  it('proxy.list with dir delegates to client.list', async () => {
    const svc = new WorkspaceService()
    const client = makeClient()
    const proxy = svc.createVaultProxy(() => client, () => undefined)
    const result = await proxy.list('Inbox')
    expect(client.list).toHaveBeenCalledWith('Inbox')
    expect(result).toEqual(['Inbox/a.md'])
  })

  it('proxy.list returns empty array when no client', async () => {
    const svc = new WorkspaceService()
    const proxy = svc.createVaultProxy(() => undefined, () => undefined)
    expect(await proxy.list()).toEqual([])
  })

  it('proxy.exists delegates to client.exists', async () => {
    const svc = new WorkspaceService()
    const client = makeClient()
    const proxy = svc.createVaultProxy(() => client, () => undefined)
    const result = await proxy.exists('doc-1')
    expect(client.exists).toHaveBeenCalledWith('doc-1')
    expect(result).toBe(true)
  })

  it('proxy.exists returns false when no client', async () => {
    const svc = new WorkspaceService()
    const proxy = svc.createVaultProxy(() => undefined, () => undefined)
    expect(await proxy.exists('doc-1')).toBe(false)
  })

  it('proxy.resolveDocumentId delegates to provided resolveDocId function', () => {
    const svc = new WorkspaceService()
    const resolveDocId = vi.fn((path: string) => `id-for-${path}`)
    const proxy = svc.createVaultProxy(() => undefined, resolveDocId)
    expect(proxy.resolveDocumentId('note.md')).toBe('id-for-note.md')
    expect(resolveDocId).toHaveBeenCalledWith('note.md')
  })

  it('proxy.resolveDocumentId returns undefined when resolveDocId returns undefined', () => {
    const svc = new WorkspaceService()
    const proxy = svc.createVaultProxy(() => undefined, () => undefined)
    expect(proxy.resolveDocumentId('unknown.md')).toBeUndefined()
  })

  it('proxy.createFile delegates to client.createFile', async () => {
    const svc = new WorkspaceService()
    const client = makeClient()
    const proxy = svc.createVaultProxy(() => client, () => undefined)
    await proxy.createFile?.('new.md')
    expect(client.createFile).toHaveBeenCalledWith('new.md')
  })

  it('proxy.createFile is a no-op when no client', async () => {
    const svc = new WorkspaceService()
    const proxy = svc.createVaultProxy(() => undefined, () => undefined)
    await expect(proxy.createFile?.('new.md')).resolves.toBeUndefined()
  })

  it('proxy.createFolder delegates to client.createFolder', async () => {
    const svc = new WorkspaceService()
    const client = makeClient()
    const proxy = svc.createVaultProxy(() => client, () => undefined)
    await proxy.createFolder?.('Inbox')
    expect(client.createFolder).toHaveBeenCalledWith('Inbox')
  })

  it('proxy.renameFile delegates to client.renameFile', async () => {
    const svc = new WorkspaceService()
    const client = makeClient()
    const proxy = svc.createVaultProxy(() => client, () => undefined)
    await proxy.renameFile?.('doc-1', 'renamed.md')
    expect(client.renameFile).toHaveBeenCalledWith('doc-1', 'renamed.md')
  })

  it('proxy.deleteFile delegates to client.deleteFile', async () => {
    const svc = new WorkspaceService()
    const client = makeClient()
    const proxy = svc.createVaultProxy(() => client, () => undefined)
    await proxy.deleteFile?.('doc-1')
    expect(client.deleteFile).toHaveBeenCalledWith('doc-1')
  })

  it('proxy.deleteFolder delegates to client.deleteFolder', async () => {
    const svc = new WorkspaceService()
    const client = makeClient()
    const proxy = svc.createVaultProxy(() => client, () => undefined)
    await proxy.deleteFolder?.('Inbox')
    expect(client.deleteFolder).toHaveBeenCalledWith('Inbox')
  })
})
