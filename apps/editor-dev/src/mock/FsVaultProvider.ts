// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { VaultAPI } from '@savoire/plugin-api'

// File System Access API types (not in lib.dom.d.ts for older TS versions)
interface FSFileHandle {
  kind: 'file'
  name: string
  getFile(): Promise<File>
  createWritable(): Promise<FileSystemWritableFileStream>
}
interface FSDirHandle {
  kind: 'directory'
  name: string
  entries(): AsyncIterableIterator<[string, FSFileHandle | FSDirHandle]>
}

declare global {
  interface Window {
    showDirectoryPicker(opts?: { mode?: 'read' | 'readwrite' }): Promise<FSDirHandle>
  }
}

/** Extensions considered as vault documents */
const VAULT_EXTS = ['.md', '.excalidraw', '.canvas', '.json']

function isVaultFile(name: string) {
  return VAULT_EXTS.some((ext) => name.endsWith(ext))
}

/**
 * VaultAPI backed by the browser File System Access API.
 * Allows the dev playground to open a real local folder.
 */
export class FsVaultProvider implements VaultAPI {
  private handles = new Map<string, FSFileHandle>()

  private constructor(private readonly rootName: string) {}

  static async fromPicker(): Promise<FsVaultProvider> {
    const dir = await window.showDirectoryPicker({ mode: 'readwrite' })
    const provider = new FsVaultProvider(dir.name)
    await provider.index(dir, '')
    return provider
  }

  /** Recursively index all vault files under the given directory. */
  private async index(dir: FSDirHandle, prefix: string): Promise<void> {
    for await (const [name, handle] of dir.entries()) {
      const path = prefix ? `${prefix}/${name}` : name
      if (handle.kind === 'file' && isVaultFile(name)) {
        this.handles.set(path, handle as FSFileHandle)
      } else if (handle.kind === 'directory') {
        await this.index(handle as FSDirHandle, path)
      }
    }
  }

  get folderName() { return this.rootName }

  async read(documentId: string): Promise<string> {
    const handle = this.handles.get(documentId)
    if (!handle) throw new Error(`[FsVaultProvider] File not found: ${documentId}`)
    const file = await handle.getFile()
    return file.text()
  }

  async readDocumentByPath(path: string): Promise<string> {
    const documentId = this.resolveDocumentId(path)
    if (!documentId) throw new Error(`[FsVaultProvider] File not found: ${path}`)
    return this.read(documentId)
  }

  async write(documentId: string, content: string): Promise<void> {
    const handle = this.handles.get(documentId)
    if (!handle) throw new Error(`[FsVaultProvider] File not found: ${documentId}`)
    const writable = await handle.createWritable()
    await writable.write(content)
    await writable.close()
  }

  async list(_dir?: string): Promise<string[]> {
    return [...this.handles.keys()].sort()
  }

  async exists(documentId: string): Promise<boolean> {
    return this.handles.has(documentId)
  }

  resolveDocumentId(path: string): string | undefined {
    if (this.handles.has(path)) return path
    const withMd = `${path}.md`
    if (this.handles.has(withMd)) return withMd
    return undefined
  }
}
