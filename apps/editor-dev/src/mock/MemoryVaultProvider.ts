// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { VaultProvider } from './types'

export class MemoryVaultProvider implements VaultProvider {
  private files: Record<string, string>

  constructor(files: Record<string, string>) {
    this.files = { ...files }
  }

  async read(documentId: string): Promise<string> {
    const content = this.files[documentId]
    if (content === undefined) throw new Error(`File not found: ${documentId}`)
    return content
  }

  async readDocumentByPath(path: string): Promise<string> {
    const documentId = this.resolveDocumentId(path)
    if (!documentId) throw new Error(`File not found: ${path}`)
    return this.read(documentId)
  }

  async write(documentId: string, content: string): Promise<void> {
    this.files[documentId] = content
  }

  async list(): Promise<string[]> {
    return Object.keys(this.files)
  }

  async exists(documentId: string): Promise<boolean> {
    return Object.prototype.hasOwnProperty.call(this.files, documentId)
  }

  resolveDocumentId(path: string): string | undefined {
    if (Object.prototype.hasOwnProperty.call(this.files, path)) return path
    const withMd = `${path}.md`
    if (Object.prototype.hasOwnProperty.call(this.files, withMd)) return withMd
    return undefined
  }
}
