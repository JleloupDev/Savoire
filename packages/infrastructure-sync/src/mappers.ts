// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { Document, Vault, type DocumentMeta } from '@savoire/domain-sync'

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function parseDate(value: unknown): Date {
  if (typeof value !== 'string') return new Date(0)
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? new Date(0) : d
}

// DTOs can come in camelCase or PascalCase depending on backend config.
export function mapDocumentMeta(dto: Record<string, unknown>): DocumentMeta {
  return {
    documentId: str(dto.id ?? dto.Id),
    name: str(dto.name ?? dto.Name ?? dto.path ?? dto.Path).split('/').at(-1) ?? '',
    path: str(dto.path ?? dto.Path),
    updatedAt: parseDate(dto.updatedAt ?? dto.UpdatedAt),
  }
}

export function mapDocument(dto: Record<string, unknown>, content: string): Document {
  const path = str(dto.path ?? dto.Path)
  const name = path.split('/').at(-1) ?? path
  return new Document({
    id: str(dto.id ?? dto.Id),
    name,
    path,
    title: str(dto.title ?? dto.Title),
    content,
    isDeleted: false,
    updatedAt: parseDate(dto.updatedAt ?? dto.UpdatedAt),
  })
}

export function mapVault(dto: Record<string, unknown>): Vault {
  const id = str(dto.id ?? dto.Id)
  const name = str(dto.name ?? dto.Name)
  return new Vault({ id, name })
}
