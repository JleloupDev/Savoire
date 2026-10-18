// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Systeme de fichiers d'un vault EN MEMOIRE (IVaultFileSystem), pour les
// tests et les essais sans disque.
//
// Il se comporte comme un vrai disque surveille :
//   - toute ecriture, d'ou qu'elle vienne, est signalee aux abonnes de
//     `watch`, apres coup (jamais pendant l'appel qui ecrit) ;
//   - un renommage garde la date de modification, comme sur un vrai disque ;
//   - les dossiers parents sont crees a l'ecriture.
//
// Une modification « externe » (un autre outil) se simule en appelant les
// memes methodes depuis le test : la session les voit par `watch`, comme sur
// un vrai disque. L'option `watch: false` simule un systeme qui ne sait pas
// surveiller le disque.
import type { FileChange, FileEntry, IVaultFileSystem } from './fileSystem'

interface StoredFile {
  bytes: Uint8Array
  mtimeMs: number
}

export interface InMemoryVaultFileSystemOptions {
  rootLabel?: string
  /** false : pas de `watch` (la session relit a la demande). Defaut : true. */
  watch?: boolean
}

function normalize(path: string): string {
  return path.split('/').filter(s => s && s !== '.').join('/')
}

function parentOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

function isUnder(path: string, dir: string): boolean {
  return dir === '' || path === dir || path.startsWith(`${dir}/`)
}

function notFound(path: string): Error {
  const err = new Error(`ENOENT: fichier introuvable : ${path}`) as Error & { code?: string }
  err.code = 'ENOENT'
  return err
}

export class InMemoryVaultFileSystem implements IVaultFileSystem {
  readonly rootLabel: string
  readonly watch?: (cb: (changes: FileChange[]) => void) => () => void

  private readonly files = new Map<string, StoredFile>()
  private readonly dirs = new Set<string>()
  private readonly watchers = new Set<(changes: FileChange[]) => void>()
  private lastMtime = 0

  constructor(options: InMemoryVaultFileSystemOptions = {}) {
    this.rootLabel = options.rootLabel ?? 'memoire'
    if (options.watch !== false) {
      this.watch = (cb) => {
        this.watchers.add(cb)
        return () => { this.watchers.delete(cb) }
      }
    }
  }

  // ── Lecture ──────────────────────────────────────────────────────────────

  async readText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readBytes(path))
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const f = this.files.get(normalize(path))
    if (!f) throw notFound(path)
    return f.bytes.slice()
  }

  async exists(path: string): Promise<boolean> {
    const p = normalize(path)
    return p === '' || this.files.has(p) || this.dirs.has(p)
  }

  async stat(path: string): Promise<FileEntry | null> {
    const p = normalize(path)
    const f = this.files.get(p)
    if (f) return { path: p, kind: 'file', size: f.bytes.length, mtimeMs: f.mtimeMs }
    if (p === '' || this.dirs.has(p)) return { path: p, kind: 'directory' }
    return null
  }

  async list(dir: string, options: { recursive?: boolean } = {}): Promise<FileEntry[]> {
    const d = normalize(dir)
    if (d !== '' && !this.dirs.has(d)) throw notFound(dir)
    const out: FileEntry[] = []
    const direct = (p: string): boolean => parentOf(p) === d
    for (const p of this.dirs) {
      if (p !== d && isUnder(p, d) && (options.recursive || direct(p))) out.push({ path: p, kind: 'directory' })
    }
    for (const [p, f] of this.files) {
      if (isUnder(p, d) && (options.recursive || direct(p))) {
        out.push({ path: p, kind: 'file', size: f.bytes.length, mtimeMs: f.mtimeMs })
      }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path))
  }

  // ── Ecriture ─────────────────────────────────────────────────────────────

  async writeText(path: string, content: string): Promise<void> {
    await this.writeBytes(path, new TextEncoder().encode(content))
  }

  async writeBytes(path: string, content: Uint8Array): Promise<void> {
    const p = normalize(path)
    if (!p || this.dirs.has(p)) throw new Error(`EISDIR: ${path} est un dossier`)
    const changes = this.ensureDir(parentOf(p))
    const existed = this.files.has(p)
    this.files.set(p, { bytes: content.slice(), mtimeMs: this.nextMtime() })
    changes.push({ path: p, kind: existed ? 'modified' : 'created' })
    this.emit(changes)
  }

  async mkdir(path: string): Promise<void> {
    const p = normalize(path)
    if (this.files.has(p)) throw new Error(`EEXIST: ${path} est un fichier`)
    this.emit(this.ensureDir(p))
  }

  async rename(from: string, to: string): Promise<void> {
    const src = normalize(from)
    const dst = normalize(to)
    if (src === dst) return
    if (!src || !(await this.exists(src))) throw notFound(from)
    if (isUnder(dst, src)) throw new Error(`EINVAL: ${to} est dans ${from}`)
    const changes = this.ensureDir(parentOf(dst))
    const file = this.files.get(src)
    if (file) {
      const replaced = this.files.has(dst)
      this.files.delete(src)
      this.files.set(dst, file)
      changes.push({ path: src, kind: 'deleted' }, { path: dst, kind: replaced ? 'modified' : 'created' })
    } else {
      // Un dossier et tout son contenu.
      for (const d of [...this.dirs].filter(d => isUnder(d, src))) {
        this.dirs.delete(d)
        this.dirs.add(dst + d.slice(src.length))
        changes.push({ path: d, kind: 'deleted' }, { path: dst + d.slice(src.length), kind: 'created' })
      }
      for (const [p, f] of [...this.files].filter(([p]) => isUnder(p, src))) {
        this.files.delete(p)
        this.files.set(dst + p.slice(src.length), f)
        changes.push({ path: p, kind: 'deleted' }, { path: dst + p.slice(src.length), kind: 'created' })
      }
    }
    this.emit(changes)
  }

  async remove(path: string): Promise<void> {
    const p = normalize(path)
    if (!p) throw new Error('EPERM: la racine ne se supprime pas')
    const changes: FileChange[] = []
    if (this.files.delete(p)) changes.push({ path: p, kind: 'deleted' })
    for (const f of [...this.files.keys()].filter(f => isUnder(f, p))) {
      this.files.delete(f)
      changes.push({ path: f, kind: 'deleted' })
    }
    for (const d of [...this.dirs].filter(d => isUnder(d, p))) {
      this.dirs.delete(d)
      changes.push({ path: d, kind: 'deleted' })
    }
    if (changes.length === 0) throw notFound(path)
    this.emit(changes)
  }

  // ── Interne ──────────────────────────────────────────────────────────────

  /** Cree le dossier et ses parents. Rend les creations, a signaler. */
  private ensureDir(dir: string): FileChange[] {
    const changes: FileChange[] = []
    const parts = dir ? dir.split('/') : []
    for (let i = 1; i <= parts.length; i++) {
      const d = parts.slice(0, i).join('/')
      if (this.files.has(d)) throw new Error(`ENOTDIR: ${d} est un fichier`)
      if (!this.dirs.has(d)) {
        this.dirs.add(d)
        changes.push({ path: d, kind: 'created' })
      }
    }
    return changes
  }

  /** Dates strictement croissantes : deux fichiers ne se confondent pas par leur date. */
  private nextMtime(): number {
    this.lastMtime = Math.max(Date.now(), this.lastMtime + 1)
    return this.lastMtime
  }

  private emit(changes: FileChange[]): void {
    if (changes.length === 0) return
    for (const cb of [...this.watchers]) {
      queueMicrotask(() => { if (this.watchers.has(cb)) cb(changes) })
    }
  }
}
