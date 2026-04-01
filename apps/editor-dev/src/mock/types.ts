// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
export interface VaultProvider {
  read(documentId: string): Promise<string>
  readDocumentByPath(path: string): Promise<string>
  write(documentId: string, content: string): Promise<void>
  list(): Promise<string[]>
  exists(documentId: string): Promise<boolean>
  resolveDocumentId(path: string): string | undefined
}

export interface MockFileSet {
  id: string
  label: string
  files: Record<string, string>
  entry?: string
}
