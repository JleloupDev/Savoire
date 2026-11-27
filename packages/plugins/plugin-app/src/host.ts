// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Cote Savoire d'une application (.app). Tout ce qu'un board sait faire
// (requetes, bases : voir BoardHost), plus les fichiers de SON dossier :
//
//   savoire.files.list(dir, { recursive })   fichiers et dossiers
//   savoire.files.read(path) / readJSON      texte d'un fichier
//   savoire.files.bytes(path) / url(path)    octets, adresse blob: (images...)
//   savoire.files.write(path, text) / writeJSON  cree ou remplace
//   savoire.files.remove(path)               a la corbeille
//   savoire.files.move(from, to)
//   savoire.files.watch(cb)                  changements du dossier
//   savoire.notify(message, type)
//
// Le dossier de l'application est celui de son fichier .app. Elle y lit et y
// ecrit sans demander (decision du 27/11/2026) ; jamais en lecture seule,
// jamais hors du dossier. Une application posee a la racine du vault n'ecrit
// rien : son dossier serait le vault entier.
//
// Les textes (JSON, JS...) sont des textes partages : une ecriture ne change
// que la difference (editText), elle fusionne avec les editions des autres.
// Les workers du cadre sont comptes (onWorkers) et peuvent etre arretes.
import type { NotificationType, PluginAPI } from '@savoire/plugin-api'
import { BoardHost, type BoardHostOptions } from '@savoire/plugin-board'
import { buildAppDocument, getAppFrameUrl, type AppLibraries } from './frame'
import { appFolderOf, isCodeFile, mimeOf, normalizeAppPath, relPathOf, rewriteModuleImports, vaultPathOf } from './paths'

/** Ecritures de fichiers au plus, par minute. */
export const MAX_FILE_WRITES_PER_MINUTE = 600
/** Taille max d'un message du cadre : un fichier entier. */
export const MAX_APP_MESSAGE = 8 * 1024 * 1024
/** Code charge avec l'application (modules, styles), au plus. */
export const MAX_APP_CODE = 20 * 1024 * 1024
/** Delai entre deux releves du dossier (files.watch). */
const WATCH_MS = 1500
/**
 * Fichiers lus par l'application dont on relit le contenu pendant le suivi
 * (les plus recents). Le releve de l'arborescence ne voit pas toujours une
 * modification faite ailleurs ; la relecture, si.
 */
const MAX_FOLLOWED = 30
/** Relecture des fichiers suivis : un releve sur deux. */
const CONTENT_EVERY = 2

export interface AppHostOptions extends Omit<BoardHostOptions, 'boardPath'> {
  /** Chemin du fichier .app. */
  appPath: string
  /** Nombre de workers du cadre qui tournent. */
  onWorkers?: (count: number) => void
}

export interface AppFileEntry {
  path: string
  name: string
  type: 'file' | 'folder'
}

type Change = { path: string; change: 'added' | 'removed' | 'changed' }

export class AppHost extends BoardHost {
  readonly appPath: string
  readonly folder: string
  private fileWrites: number[] = []
  private watchTimer: ReturnType<typeof setInterval> | null = null
  private unsubVault: (() => void) | null = null
  private seen: Map<string, string> | null = null
  /** Dernier contenu connu des fichiers lus ou ecrits (relu pendant le suivi). */
  private readonly known = new Map<string, string>()
  private ticks = 0
  private polling = false

  constructor(api: PluginAPI | undefined, private readonly appOpts: AppHostOptions) {
    super(api, { ...appOpts, boardPath: appOpts.appPath })
    this.appPath = appOpts.appPath
    this.folder = appFolderOf(appOpts.appPath)
    this.maxMessage = MAX_APP_MESSAGE
    this.frame.dataset.testid = 'app-frame'
    this.frame.setAttribute('allow', 'fullscreen')
  }

  protected override frameUrl(): string | null {
    return getAppFrameUrl()
  }

  /** Charge l'application : son code, les modules de son dossier, les bibliotheques. */
  async loadApp(source: string, libraries: AppLibraries): Promise<void> {
    const files = await this.codeFiles()
    if (this.isDisposed) return
    const vault = this.api?.vault
    const name = this.appPath.slice(this.appPath.lastIndexOf('/') + 1).replace(/\.app$/i, '')
    this.boot(buildAppDocument({
      source, files, libraries,
      channel: this.channel,
      readOnly: this.writesBlocked(),
      app: { path: this.appPath, folder: this.folder, name },
      user: vault?.getCurrentUser?.() ?? null,
    }))
  }

  /** Arrete les workers du cadre. */
  stopWorkers(): void {
    this.post({ t: 'stop-workers' })
  }

  override dispose(): void {
    this.stopFileWatch()
    super.dispose()
  }

  private writesBlocked(): boolean {
    return this.appOpts.readOnly || !this.folder
  }

  /** Les modules et styles du dossier (.js, .mjs, .css), imports relatifs reecrits. */
  private async codeFiles(): Promise<Record<string, string>> {
    const out: Record<string, string> = {}
    let total = 0
    for (const rel of (await this.listRel(true)).filter(e => e.type === 'file' && isCodeFile(e.path)).map(e => e.path)) {
      const text = await this.readText(rel).catch(() => null)
      if (text === null) continue
      total += text.length
      if (total > MAX_APP_CODE) throw new Error(`Trop de code dans le dossier de l'application (${MAX_APP_CODE / 1024 / 1024} Mo au plus).`)
      out[rel] = /\.css$/i.test(rel) ? text : rewriteModuleImports(rel, text)
    }
    return out
  }

  protected override onExtraMessage(m: Record<string, unknown>): void {
    if (m.t === 'workers' && typeof m.n === 'number' && Number.isFinite(m.n)) this.appOpts.onWorkers?.(Math.max(0, Math.min(10_000, m.n)))
  }

  protected override async call(fn: string, args: unknown[]): Promise<unknown> {
    switch (fn) {
      case 'files.list': return this.listRel(!!args[1], typeof args[0] === 'string' ? args[0] : '')
      case 'files.read': return this.readText(normalizeAppPath(args[0]))
      case 'files.bytes': return this.readBytes(normalizeAppPath(args[0]), args[1], args[2])
      case 'files.size': return this.size(normalizeAppPath(args[0]))
      case 'files.write': return this.writeText(normalizeAppPath(args[0]), args[1])
      case 'files.remove': return this.remove(normalizeAppPath(args[0]))
      case 'files.move': return this.move(normalizeAppPath(args[0]), normalizeAppPath(args[1]))
      case 'files.watch': this.startFileWatch(); return true
      case 'files.unwatch': this.stopFileWatch(); return true
      case 'notify': {
        const type = (['success', 'info', 'warn', 'danger'] as const).includes(args[1] as NotificationType) ? args[1] as NotificationType : 'info'
        this.api?.workspace.notify?.(type, String(args[0] ?? '').slice(0, 300))
        return true
      }
      default: return super.call(fn, args)
    }
  }

  // ── Fichiers ──────────────────────────────────────────────────────────

  /**
   * Les fichiers du dossier (chemins du vault), d'apres le repertoire du
   * vault (a jour tout de suite), et la version connue de chacun (releve de
   * l'index, quand il l'a deja vu).
   */
  private async tree(): Promise<{ path: string; version: string }[]> {
    const vault = this.api?.vault
    if (!vault) return []
    const versions = new Map<string, string>()
    for (const f of vault.getFileTree?.() ?? []) versions.set(f.path, JSON.stringify(f.crdtVersion ?? null))
    const out: { path: string; version: string }[] = []
    const dirs = [this.folder ? `${this.folder}/` : '']
    const seen = new Set<string>()
    while (dirs.length) {
      const dir = dirs.pop()!
      if (seen.has(dir)) continue
      seen.add(dir)
      for (const entry of await vault.list(dir).catch(() => [] as string[])) {
        if (entry.startsWith('.trash/')) continue
        if (entry.endsWith('/')) dirs.push(entry)
        else out.push({ path: entry, version: versions.get(entry) ?? '' })
      }
    }
    return out
  }

  /** Fichiers et dossiers du dossier de l'application (ou d'un sous-dossier). */
  async listRel(recursive: boolean, dir = ''): Promise<AppFileEntry[]> {
    const sub = dir ? normalizeAppPath(dir) : ''
    const prefix = sub ? `${sub}/` : ''
    const files: AppFileEntry[] = []
    const folders = new Set<string>()
    for (const f of await this.tree()) {
      const rel = relPathOf(this.folder, f.path)
      if (rel === null || !rel.startsWith(prefix)) continue
      const rest = rel.slice(prefix.length)
      const parts = rest.split('/')
      for (let i = 1; i < parts.length; i++) {
        if (!recursive && i > 1) break
        folders.add(prefix + parts.slice(0, i).join('/'))
      }
      if (recursive || parts.length === 1) files.push({ path: rel, name: parts[parts.length - 1], type: 'file' })
    }
    const out: AppFileEntry[] = [...folders].map(p => ({ path: p, name: p.slice(p.lastIndexOf('/') + 1), type: 'folder' as const }))
    return out.concat(files).sort((a, b) => a.path.localeCompare(b.path))
  }

  private docOf(rel: string): string {
    const vault = this.api?.vault
    if (!vault) throw new Error('Aucun vault ouvert.')
    const path = vaultPathOf(this.folder, rel)
    const id = vault.resolveDocumentId(path)
    if (!id) throw new Error(`Fichier introuvable : ${rel}`)
    return id
  }

  private async readText(rel: string): Promise<string> {
    const vault = this.api!.vault
    const path = vaultPathOf(this.folder, rel)
    this.docOf(rel)
    let text: string
    try {
      // Par le chemin : un fichier garde tel quel (bibliotheque envoyee par
      // add_file) se lit comme ses octets, un texte partage comme son texte.
      text = await vault.readDocumentByPath(path)
    } catch (err) {
      // Fichier envoye tel quel (octets) : lu comme du texte UTF-8.
      const bytes = await vault.readBinary?.(path).catch(() => null)
      if (!bytes) throw err
      text = new TextDecoder().decode(bytes)
    }
    this.rememberText(rel, text)
    return text
  }

  private rememberText(rel: string, text: string): void {
    this.known.delete(rel)
    this.known.set(rel, text)
    while (this.known.size > MAX_FOLLOWED) this.known.delete(this.known.keys().next().value as string)
  }

  private async readBytes(rel: string, start?: unknown, end?: unknown): Promise<{ bytes: Uint8Array; mime: string; size?: number }> {
    const vault = this.api!.vault
    const path = vaultPathOf(this.folder, rel)
    this.docOf(rel)
    // Lecture partielle : un morceau seulement (fonds de carte, gros fichiers).
    if (typeof start === 'number' && Number.isFinite(start)) {
      const to = typeof end === 'number' && Number.isFinite(end) ? end : start + 1024 * 1024
      if (to - start > MAX_APP_MESSAGE) throw new Error(`Morceau trop grand (${MAX_APP_MESSAGE / 1024 / 1024} Mo au plus).`)
      const part = await vault.readBinaryRange?.(path, start, to).catch(() => null)
      if (part) return { bytes: part.bytes, mime: mimeOf(rel), size: part.size }
      const all = (await this.readBytes(rel)).bytes
      return { bytes: all.slice(start, to), mime: mimeOf(rel), size: all.length }
    }
    const bytes = await vault.readBinary?.(path).catch(() => null)
    if (bytes) return { bytes, mime: mimeOf(rel) }
    return { bytes: new TextEncoder().encode(await this.readText(rel)), mime: mimeOf(rel) }
  }

  /** Taille d'un fichier (octets), sans le lire en entier quand c'est possible. */
  private async size(rel: string): Promise<number> {
    const path = vaultPathOf(this.folder, rel)
    this.docOf(rel)
    const part = await this.api!.vault.readBinaryRange?.(path, 0, 1).catch(() => null)
    if (part) return part.size
    return (await this.readBytes(rel)).bytes.length
  }

  private allowFileWrite(): void {
    if (this.appOpts.readOnly) throw new Error('Lecture seule : rien ne peut être modifié ici.')
    if (!this.folder) throw new Error('Cette application est à la racine du vault : rangez-la dans un dossier pour qu\'elle puisse écrire.')
    const now = Date.now()
    this.fileWrites = this.fileWrites.filter(t => now - t < 60_000)
    if (this.fileWrites.length >= MAX_FILE_WRITES_PER_MINUTE) throw new Error(`Trop d'écritures (${MAX_FILE_WRITES_PER_MINUTE} par minute au plus).`)
    this.fileWrites.push(now)
  }

  private async writeText(rel: string, text: unknown): Promise<{ path: string }> {
    if (typeof text !== 'string') throw new Error('files.write : texte attendu.')
    this.allowFileWrite()
    const vault = this.api!.vault
    const path = vaultPathOf(this.folder, rel)
    let id = vault.resolveDocumentId(path)
    // Un fichier garde tel quel (envoye par add_file) ne se reecrit pas : il
    // part a la corbeille et un texte partage prend sa place.
    if (id && vault.isStoredFile?.(path) && vault.deleteFile) {
      await vault.deleteFile(id)
      id = undefined
    }
    if (!id) {
      if (!vault.createFile) throw new Error('Ce vault ne permet pas de créer de fichier.')
      const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
      if (dir) await vault.createFolder?.(dir)
      await vault.createFile(path)
      id = await waitForId(this.api!, path)
    }
    if (vault.editText) {
      await vault.editText(id, () => text)
    } else {
      await vault.write(id, text)
    }
    this.rememberText(rel, text)
    return { path: rel }
  }

  private async remove(rel: string): Promise<boolean> {
    this.allowFileWrite()
    const vault = this.api!.vault
    if (!vault.deleteFile) throw new Error('Ce vault ne permet pas de supprimer.')
    await vault.deleteFile(this.docOf(rel))
    return true
  }

  private async move(from: string, to: string): Promise<{ path: string }> {
    this.allowFileWrite()
    const vault = this.api!.vault
    if (!vault.renameFile) throw new Error('Ce vault ne permet pas de déplacer.')
    const target = vaultPathOf(this.folder, to)
    if (vault.resolveDocumentId(target)) throw new Error(`Un fichier existe déjà : ${to}`)
    const dir = target.includes('/') ? target.slice(0, target.lastIndexOf('/')) : ''
    if (dir) await vault.createFolder?.(dir)
    await vault.renameFile(this.docOf(from), target)
    return { path: to }
  }

  // ── Suivi du dossier ──────────────────────────────────────────────────

  private async snapshot(): Promise<Map<string, string>> {
    const map = new Map<string, string>()
    for (const f of await this.tree()) {
      const rel = relPathOf(this.folder, f.path)
      if (rel !== null) map.set(rel, f.version)
    }
    return map
  }

  private checking = false

  private async check(): Promise<void> {
    if (!this.seen || this.isDisposed || this.checking) return
    this.checking = true
    let now: Map<string, string>
    try { now = await this.snapshot() } finally { this.checking = false }
    if (!this.seen || this.isDisposed) return
    const changes: Change[] = []
    for (const [p, v] of now) {
      const before = this.seen.get(p)
      if (before === undefined) changes.push({ path: p, change: 'added' })
      else if (before !== v) changes.push({ path: p, change: 'changed' })
    }
    for (const p of this.seen.keys()) if (!now.has(p)) changes.push({ path: p, change: 'removed' })
    this.seen = now
    for (const c of changes) if (c.change !== 'added') this.known.delete(c.path)
    if (changes.length) this.post({ t: 'files', changes })
    if (++this.ticks % CONTENT_EVERY === 0) void this.pollContents(new Set(changes.map(c => c.path)))
  }

  /** Relit les fichiers suivis ; signale ceux dont le texte a change ailleurs. */
  private async pollContents(already: Set<string>): Promise<void> {
    if (this.polling || !this.api) return
    this.polling = true
    try {
      const changed: Change[] = []
      for (const [rel, before] of [...this.known]) {
        if (this.isDisposed || !this.seen) return
        if (already.has(rel)) continue
        const full = vaultPathOf(this.folder, rel)
        if (!this.api.vault.resolveDocumentId(full)) continue
        const now = await this.api.vault.readDocumentByPath(full).catch(() => null)
        if (now === null || now === before) continue
        this.known.set(rel, now)
        changed.push({ path: rel, change: 'changed' })
      }
      if (changed.length && this.seen) this.post({ t: 'files', changes: changed })
    } finally {
      this.polling = false
    }
  }

  private startFileWatch(): void {
    if (this.seen || this.watchTimer) return
    this.watchTimer = setInterval(() => void this.check(), WATCH_MS)
    this.unsubVault = this.api?.workspace.subscribeVaultChange?.(() => void this.check()) ?? null
    void this.snapshot().then(m => { if (this.watchTimer) this.seen = m })
  }

  private stopFileWatch(): void {
    if (this.watchTimer) clearInterval(this.watchTimer)
    this.watchTimer = null
    this.unsubVault?.()
    this.unsubVault = null
    this.seen = null
    this.ticks = 0
  }
}

/** L'id d'un document tout juste cree (l'arborescence suit un peu apres). */
async function waitForId(api: PluginAPI, path: string, timeoutMs = 5000): Promise<string> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const id = api.vault.resolveDocumentId(path) ?? (api.vault.getFileTree?.() ?? []).find(f => f.path === path)?.docId
    if (id) return id
    if (Date.now() > until) throw new Error(`Fichier introuvable après sa création : ${path}`)
    await new Promise(res => setTimeout(res, 50))
  }
}
