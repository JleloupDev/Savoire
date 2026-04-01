// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, expect, it } from 'vitest'
import { Document } from '@savoire/domain-sync'

describe('Document', () => {
  it('builds a valid meta projection', () => {
    const d = new Document({ id: 'd1', name: 'note.md', path: 'Inbox/note.md' })
    expect(d.toMeta()).toMatchObject({
      documentId: 'd1',
      name: 'note.md',
      path: 'Inbox/note.md',
    })
  })

  it('toMeta includes updatedAt', () => {
    const t = new Date('2026-01-01T00:00:00.000Z')
    const d = new Document({ id: 'd1', name: 'note.md', path: 'note.md', updatedAt: t })
    expect(d.toMeta().updatedAt).toEqual(t)
  })

  it('renames document and preserves parent folder path', () => {
    const d = new Document({ id: 'd1', name: 'note.md', path: 'Inbox/note.md' })
    d.renameTo('renamed.md')
    expect(d.name).toBe('renamed.md')
    expect(d.path).toBe('Inbox/renamed.md')
  })

  it('renames document in root path', () => {
    const d = new Document({ id: 'd1', name: 'note.md', path: 'note.md' })
    d.renameTo('renamed.md')
    expect(d.path).toBe('renamed.md')
  })

  it('moves document and updates name from the new path (with folder)', () => {
    const d = new Document({ id: 'd1', name: 'old.md', path: 'old.md' })
    d.moveTo('Projects/new.md')
    expect(d.path).toBe('Projects/new.md')
    expect(d.name).toBe('new.md')
  })

  it('updates content', () => {
    const d = new Document({ id: 'd1', name: 'note.md', path: 'note.md', content: 'A' })
    d.setContent('B')
    expect(d.content).toBe('B')
  })

  it('toggles deleted state', () => {
    const d = new Document({ id: 'd1', name: 'note.md', path: 'note.md' })
    d.markDeleted()
    expect(d.isDeleted).toBe(true)
    d.restore()
    expect(d.isDeleted).toBe(false)
  })

  it('rejects empty name at creation', () => {
    expect(() => new Document({ id: 'd1', name: '   ', path: 'note.md' })).toThrow('name must not be empty')
  })

  it('rejects empty path at creation', () => {
    expect(() => new Document({ id: 'd1', name: 'note.md', path: '   ' })).toThrow('path must not be empty')
  })

  it('rejects empty rename', () => {
    const d = new Document({ id: 'd1', name: 'note.md', path: 'note.md' })
    expect(() => d.renameTo('  ')).toThrow('newName must not be empty')
  })

  it('rejects empty move target', () => {
    const d = new Document({ id: 'd1', name: 'note.md', path: 'note.md' })
    expect(() => d.moveTo('  ')).toThrow('newPath must not be empty')
  })

  // ── Coverage additions ────────────────────────────────────────────────────

  it('moveTo root path (no slash) sets name to the full normalized path', () => {
    const d = new Document({ id: 'd1', name: 'old.md', path: 'Folder/old.md' })
    d.moveTo('root.md')
    expect(d.path).toBe('root.md')
    expect(d.name).toBe('root.md')
  })

  it('defaults title to empty string', () => {
    const d = new Document({ id: 'd1', name: 'note.md', path: 'note.md' })
    expect(d.title).toBe('')
  })

  it('accepts explicit title', () => {
    const d = new Document({ id: 'd1', name: 'note.md', path: 'note.md', title: 'My Title' })
    expect(d.title).toBe('My Title')
  })

  it('accepts explicit updatedAt', () => {
    const t = new Date('2025-06-01T12:00:00.000Z')
    const d = new Document({ id: 'd1', name: 'note.md', path: 'note.md', updatedAt: t })
    expect(d.updatedAt).toEqual(t)
  })

  it('defaults updatedAt to current time when not provided', () => {
    const before = Date.now()
    const d = new Document({ id: 'd1', name: 'note.md', path: 'note.md' })
    expect(d.updatedAt.getTime()).toBeGreaterThanOrEqual(before)
  })

  it('defaults content to empty string', () => {
    const d = new Document({ id: 'd1', name: 'note.md', path: 'note.md' })
    expect(d.content).toBe('')
  })

  it('defaults isDeleted to false', () => {
    const d = new Document({ id: 'd1', name: 'note.md', path: 'note.md' })
    expect(d.isDeleted).toBe(false)
  })

  it('accepts explicit isDeleted=true', () => {
    const d = new Document({ id: 'd1', name: 'note.md', path: 'note.md', isDeleted: true })
    expect(d.isDeleted).toBe(true)
  })

  it('renameTo updates updatedAt', () => {
    const before = new Date(0)
    const d = new Document({ id: 'd1', name: 'note.md', path: 'note.md', updatedAt: before })
    d.renameTo('new.md')
    expect(d.updatedAt.getTime()).toBeGreaterThan(before.getTime())
  })

  it('moveTo updates updatedAt', () => {
    const before = new Date(0)
    const d = new Document({ id: 'd1', name: 'note.md', path: 'note.md', updatedAt: before })
    d.moveTo('Folder/note.md')
    expect(d.updatedAt.getTime()).toBeGreaterThan(before.getTime())
  })

  it('setContent updates updatedAt', () => {
    const before = new Date(0)
    const d = new Document({ id: 'd1', name: 'note.md', path: 'note.md', updatedAt: before })
    d.setContent('new content')
    expect(d.updatedAt.getTime()).toBeGreaterThan(before.getTime())
  })

  it('markDeleted updates updatedAt', () => {
    const before = new Date(0)
    const d = new Document({ id: 'd1', name: 'note.md', path: 'note.md', updatedAt: before })
    d.markDeleted()
    expect(d.updatedAt.getTime()).toBeGreaterThan(before.getTime())
  })

  it('restore updates updatedAt', () => {
    const before = new Date(0)
    const d = new Document({ id: 'd1', name: 'note.md', path: 'note.md', isDeleted: true, updatedAt: before })
    d.restore()
    expect(d.updatedAt.getTime()).toBeGreaterThan(before.getTime())
  })
})
