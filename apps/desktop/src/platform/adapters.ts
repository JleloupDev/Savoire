// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
/**
 * Tauri filesystem adapters — implémentent les ports platform pour le desktop.
 *
 * IDocumentFetcher  → readTextFile(vaultPath/docId)
 * IVaultStorage     → readTextFile / writeTextFile / asset:// URL
 *
 * token ignoré (pas d'auth sur filesystem local).
 */
import type { IDocumentFetcher, IVaultStorage, IDocumentMeta } from '@savoire/platform'

function normSep(p: string): string {
  return p.replace(/\\/g, '/')
}

function toRelative(absolutePath: string, base: string): string {
  const normPath = normSep(absolutePath)
  const normBase = normSep(base)
  const prefix = normBase.endsWith('/') ? normBase : normBase + '/'
  return normPath.startsWith(prefix) ? normPath.slice(prefix.length) : normPath
}

export const desktopDocumentFetcher: IDocumentFetcher = {
  async getDocumentContent(vaultId, docId) {
    const { readTextFile } = await import('@tauri-apps/api/fs')
    const { join } = await import('@tauri-apps/api/path')
    return readTextFile(await join(vaultId, docId))
  },
  async writeDocumentContent(vaultId, docId, content) {
    const { writeTextFile } = await import('@tauri-apps/api/fs')
    const { join } = await import('@tauri-apps/api/path')
    return writeTextFile(await join(vaultId, docId), content)
  },
}

export const desktopVaultStorage: IVaultStorage = {
  async readFile(vaultId, path) {
    const { readTextFile } = await import('@tauri-apps/api/fs')
    const { join } = await import('@tauri-apps/api/path')
    return readTextFile(await join(vaultId, path))
  },

  async writeFile(vaultId, path, content) {
    const { writeTextFile } = await import('@tauri-apps/api/fs')
    const { join } = await import('@tauri-apps/api/path')
    await writeTextFile(await join(vaultId, path), content)
  },

  resolveFileUrl(_vaultId, path) {
    return `asset://${normSep(path)}`
  },

  async listDocuments(vaultId) {
    return listMarkdownDocs(vaultId)
  },

  async createDocument(vaultId, path) {
    const normalizedPath = path.endsWith('.md') ? path : `${path}.md`
    const { writeTextFile, createDir } = await import('@tauri-apps/api/fs')
    const { join, dirname } = await import('@tauri-apps/api/path')
    const fullPath = await join(vaultId, normalizedPath)
    await createDir(await dirname(fullPath), { recursive: true })
    await writeTextFile(fullPath, '')
    return { id: normalizedPath, path: normalizedPath }
  },

  async renameDocument(vaultId, docId, path) {
    const normalizedPath = path.endsWith('.md') ? path : `${path}.md`
    const { readTextFile, writeTextFile, removeFile, createDir } = await import('@tauri-apps/api/fs')
    const { join, dirname } = await import('@tauri-apps/api/path')
    const sourcePath = await join(vaultId, docId)
    const targetPath = await join(vaultId, normalizedPath)
    const content = await readTextFile(sourcePath)
    await createDir(await dirname(targetPath), { recursive: true })
    await writeTextFile(targetPath, content)
    if (normSep(sourcePath) !== normSep(targetPath)) await removeFile(sourcePath)
  },

  async deleteDocument(vaultId, docId) {
    const { removeFile } = await import('@tauri-apps/api/fs')
    const { join } = await import('@tauri-apps/api/path')
    await removeFile(await join(vaultId, docId))
  },

  async createFolder(vaultId, path) {
    const { createDir } = await import('@tauri-apps/api/fs')
    const { join } = await import('@tauri-apps/api/path')
    await createDir(await join(vaultId, path), { recursive: true })
  },

  async deleteFolder(vaultId, path) {
    const { removeDir } = await import('@tauri-apps/api/fs')
    const { join } = await import('@tauri-apps/api/path')
    await removeDir(await join(vaultId, path), { recursive: true })
  },
}

/** Discover all .md files in a vault folder (recursive). */
export async function listMarkdownDocs(vaultPath: string): Promise<IDocumentMeta[]> {
  const { readDir } = await import('@tauri-apps/api/fs')
  type FileEntry = { path: string; name?: string; children?: FileEntry[] }

  const entries = await readDir(vaultPath, { recursive: true }) as FileEntry[]
  const result: IDocumentMeta[] = []

  function collect(items: FileEntry[]) {
    for (const e of items) {
      if (e.children) {
        collect(e.children)
      } else if (e.name?.toLowerCase().endsWith('.md') && e.path) {
        const rel = toRelative(e.path, vaultPath)
        result.push({ id: rel, path: rel })
      }
    }
  }

  collect(entries)
  return result.sort((a, b) => a.path.localeCompare(b.path))
}
