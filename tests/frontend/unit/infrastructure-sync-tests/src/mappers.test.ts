// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect } from 'vitest'
import { mapDocumentMeta, mapDocument, mapVault } from '@savoire/infrastructure-sync'

describe('mapDocumentMeta', () => {
  it('maps camelCase DTO', () => {
    const meta = mapDocumentMeta({
      id: 'doc-1',
      path: 'Inbox/note.md',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    expect(meta.documentId).toBe('doc-1')
    expect(meta.path).toBe('Inbox/note.md')
    expect(meta.name).toBe('note.md')
    expect(meta.updatedAt).toEqual(new Date('2026-01-01T00:00:00.000Z'))
  })

  it('maps PascalCase DTO', () => {
    const meta = mapDocumentMeta({
      Id: 'doc-2',
      Path: 'root.md',
      UpdatedAt: '2026-03-01T00:00:00.000Z',
    })
    expect(meta.documentId).toBe('doc-2')
    expect(meta.path).toBe('root.md')
    expect(meta.name).toBe('root.md')
  })

  it('derives name from path when name field missing', () => {
    const meta = mapDocumentMeta({ id: 'x', path: 'Folder/Sub/file.md' })
    expect(meta.name).toBe('file.md')
  })

  it('uses name field if present', () => {
    const meta = mapDocumentMeta({ id: 'x', path: 'file.md', name: 'custom.md' })
    expect(meta.name).toBe('custom.md')
  })

  it('returns epoch date for invalid date string', () => {
    const meta = mapDocumentMeta({ id: 'x', path: 'a.md', updatedAt: 'not-a-date' })
    expect(meta.updatedAt).toEqual(new Date(0))
  })

  it('returns epoch date when updatedAt is missing', () => {
    const meta = mapDocumentMeta({ id: 'x', path: 'a.md' })
    expect(meta.updatedAt).toEqual(new Date(0))
  })

  it('returns empty strings for missing fields', () => {
    const meta = mapDocumentMeta({})
    expect(meta.documentId).toBe('')
    expect(meta.path).toBe('')
    expect(meta.name).toBe('')
  })
})

describe('mapDocument', () => {
  it('maps camelCase DTO with content', () => {
    const doc = mapDocument(
      { id: 'doc-1', path: 'note.md', title: 'My Note', updatedAt: '2026-01-01T00:00:00.000Z' },
      '# Content',
    )
    expect(doc.id).toBe('doc-1')
    expect(doc.path).toBe('note.md')
    expect(doc.name).toBe('note.md')
    expect(doc.title).toBe('My Note')
    expect(doc.content).toBe('# Content')
    expect(doc.isDeleted).toBe(false)
  })

  it('maps PascalCase DTO', () => {
    const doc = mapDocument(
      { Id: 'doc-2', Path: 'Inbox/todo.md', Title: 'Todo', UpdatedAt: '2026-02-01T00:00:00.000Z' },
      '- item',
    )
    expect(doc.id).toBe('doc-2')
    expect(doc.path).toBe('Inbox/todo.md')
    expect(doc.name).toBe('todo.md')
  })

  it('derives name as last path segment', () => {
    const doc = mapDocument({ id: 'x', path: 'A/B/C/file.md' }, '')
    expect(doc.name).toBe('file.md')
  })

  it('name equals path when no slash present', () => {
    const doc = mapDocument({ id: 'x', path: 'root.md' }, '')
    expect(doc.name).toBe('root.md')
    expect(doc.path).toBe('root.md')
  })

  it('sets isDeleted to false always', () => {
    const doc = mapDocument({ id: 'x', path: 'a.md' }, '')
    expect(doc.isDeleted).toBe(false)
  })
})

describe('mapVault', () => {
  it('maps camelCase DTO', () => {
    const vault = mapVault({ id: 'v1', name: 'Main' })
    expect(vault.id).toBe('v1')
    expect(vault.name).toBe('Main')
  })

  it('maps PascalCase DTO', () => {
    const vault = mapVault({ Id: 'v2', Name: 'Secondary' })
    expect(vault.id).toBe('v2')
    expect(vault.name).toBe('Secondary')
  })
})
