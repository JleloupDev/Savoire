// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Systeme de fichiers d'un vault sur un VRAI dossier, par node:fs. Sert aux
// tests d'integration (dossier temporaire). Range dans les tests, hors des
// paquets : node:fs ne doit jamais entrer dans le bundle web.
//
// Ecriture atomique : fichier temporaire cache a cote, puis renommage.
// Surveillance : fs.watch recursif (Linux, macOS, Windows avec Node >= 20).
import * as fsp from 'node:fs/promises'
import { existsSync, watch as fsWatch } from 'node:fs'
import * as nodePath from 'node:path'
import type { FileChange, FileEntry, IVaultFileSystem } from '@savoire/platform'

export class NodeVaultFileSystem implements IVaultFileSystem {
  readonly rootLabel: string
  readonly watch?: (cb: (changes: FileChange[]) => void) => () => void
  private tmpSeq = 0

  constructor(private readonly root: string, options: { watch?: boolean } = {}) {
    this.rootLabel = root
    if (options.watch !== false) this.watch = cb => this.startWatch(cb)
  }

  private abs(path: string): string {
    const clean = path.split('/').filter(s => s && s !== '.')
    if (clean.includes('..')) throw new Error(`chemin hors du vault : ${path}`)
    return nodePath.join(this.root, ...clean)
  }

  private rel(abs: string): string {
    return nodePath.relative(this.root, abs).split(nodePath.sep).join('/')
  }

  async readText(path: string): Promise<string> {
    return fsp.readFile(this.abs(path), 'utf8')
  }

  async readBytes(path: string): Promise<Uint8Array> {
    return new Uint8Array(await fsp.readFile(this.abs(path)))
  }

  async writeText(path: string, content: string): Promise<void> {
    await this.writeBytes(path, new TextEncoder().encode(content))
  }

  async writeBytes(path: string, content: Uint8Array): Promise<void> {
    const target = this.abs(path)
    await fsp.mkdir(nodePath.dirname(target), { recursive: true })
    const tmp = nodePath.join(nodePath.dirname(target), `.${nodePath.basename(target)}.${process.pid}.${this.tmpSeq++}.tmp`)
    await fsp.writeFile(tmp, content)
    await fsp.rename(tmp, target)
  }

  async exists(path: string): Promise<boolean> {
    try { await fsp.access(this.abs(path)); return true } catch { return false }
  }

  async stat(path: string): Promise<FileEntry | null> {
    try {
      const st = await fsp.stat(this.abs(path))
      return st.isDirectory()
        ? { path, kind: 'directory' }
        : { path, kind: 'file', size: st.size, mtimeMs: st.mtimeMs }
    } catch {
      return null
    }
  }

  async list(dir: string, options: { recursive?: boolean } = {}): Promise<FileEntry[]> {
    const out: FileEntry[] = []
    const walk = async (absDir: string): Promise<void> => {
      for (const d of await fsp.readdir(absDir, { withFileTypes: true })) {
        const abs = nodePath.join(absDir, d.name)
        if (d.isDirectory()) {
          out.push({ path: this.rel(abs), kind: 'directory' })
          if (options.recursive) await walk(abs)
        } else if (d.isFile()) {
          const st = await fsp.stat(abs).catch(() => null)
          if (st) out.push({ path: this.rel(abs), kind: 'file', size: st.size, mtimeMs: st.mtimeMs })
        }
      }
    }
    await walk(this.abs(dir))
    return out.sort((a, b) => a.path.localeCompare(b.path))
  }

  async mkdir(path: string): Promise<void> {
    await fsp.mkdir(this.abs(path), { recursive: true })
  }

  async rename(from: string, to: string): Promise<void> {
    const target = this.abs(to)
    await fsp.mkdir(nodePath.dirname(target), { recursive: true })
    await fsp.rename(this.abs(from), target)
  }

  async remove(path: string): Promise<void> {
    await fsp.rm(this.abs(path), { recursive: true })
  }

  private startWatch(cb: (changes: FileChange[]) => void): () => void {
    const tmpName = new RegExp(`^\\.(.+)\\.${process.pid}\\.\\d+\\.tmp$`)
    const watcher = fsWatch(this.root, { recursive: true }, (event, filename) => {
      if (!filename) return
      const rel = String(filename).split(nodePath.sep).join('/')
      const present = existsSync(nodePath.join(this.root, String(filename)))
      const kind: FileChange['kind'] = event === 'change' ? 'modified' : present ? 'created' : 'deleted'
      // Le watch recursif de Node (Linux) perd parfois un fichier remplace par
      // renommage : la disparition de notre fichier temporaire annonce donc
      // l'ecriture de sa cible.
      const slash = rel.lastIndexOf('/')
      const tmp = kind === 'deleted' ? tmpName.exec(rel.slice(slash + 1)) : null
      if (tmp) cb([{ path: `${rel.slice(0, slash + 1)}${tmp[1]}`, kind: 'modified' }])
      else cb([{ path: rel, kind }])
    })
    return () => watcher.close()
  }
}
