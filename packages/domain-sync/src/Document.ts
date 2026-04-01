// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { DocumentId, DocumentMeta } from './types'

function now(): Date {
  return new Date()
}

function trimNonEmpty(value: string, label: string): string {
  const v = value.trim()
  if (!v) throw new Error(`${label} must not be empty`)
  return v
}

function parentPath(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i + 1)
}

export class Document {
  public readonly id: DocumentId
  public name: string
  public path: string
  public title: string
  public content: string
  public isDeleted: boolean
  public updatedAt: Date

  constructor(params: {
    id: DocumentId
    name: string
    path: string
    title?: string
    content?: string
    isDeleted?: boolean
    updatedAt?: Date
  }) {
    this.id = params.id
    this.name = trimNonEmpty(params.name, 'name')
    this.path = trimNonEmpty(params.path, 'path')
    this.title = params.title ?? ''
    this.content = params.content ?? ''
    this.isDeleted = params.isDeleted ?? false
    this.updatedAt = params.updatedAt ?? now()
  }

  toMeta(): DocumentMeta {
    return {
      documentId: this.id,
      name: this.name,
      path: this.path,
      updatedAt: this.updatedAt,
    }
  }

  renameTo(newName: string): void {
    const normalized = trimNonEmpty(newName, 'newName')
    this.name = normalized
    this.path = parentPath(this.path) + normalized
    this.updatedAt = now()
  }

  moveTo(newPath: string): void {
    const normalized = trimNonEmpty(newPath, 'newPath')
    this.path = normalized
    const slashIdx = normalized.lastIndexOf('/')
    this.name = slashIdx === -1 ? normalized : normalized.slice(slashIdx + 1)
    this.updatedAt = now()
  }

  setContent(content: string): void {
    this.content = content
    this.updatedAt = now()
  }

  markDeleted(): void {
    this.isDeleted = true
    this.updatedAt = now()
  }

  restore(): void {
    this.isDeleted = false
    this.updatedAt = now()
  }
}
