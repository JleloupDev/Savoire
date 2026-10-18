// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Journal des mises a jour d'un CRDT dans un dossier de `.savoire/` : chaque
// lot de modifications locales devient un petit fichier, jamais reecrit. De
// temps en temps, on compacte : l'etat complet dans un seul fichier, puis on
// efface les fichiers qu'il contient.
//
// Pourquoi des fichiers ajoutes plutot qu'un fichier unique reecrit : deux
// sessions sur le meme dossier (deux fenetres) n'ecrasent jamais les ecritures
// l'une de l'autre. Une mise a jour Yjs s'applique plusieurs fois sans effet,
// dans n'importe quel ordre ; lire un fichier deux fois ne coute rien.
//
// Regle de compaction : on n'efface que des fichiers DEJA LUS, dont le
// contenu est donc dans l'etat qu'on vient d'ecrire. Un fichier pose par une
// autre session pendant la compaction reste en place.
import * as Y from 'yjs'
import type { IVaultFileSystem } from '@savoire/platform'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Y_ = Y as Record<string, any>

const UPDATE_EXT = '.update'
const STATE_EXT = '.state'

/** Au-dela de ce nombre de fichiers, on compacte a la prochaine ecriture. */
const COMPACT_AFTER = 32

export interface UpdateLogOptions {
  /** Regroupement des modifications locales avant ecriture (ms). */
  persistMs: number
  /** Etat complet courant, pour la compaction. */
  fullState(): Uint8Array
  /** Une ecriture a echoue (disque plein, droits) : a signaler. */
  onError(err: unknown): void
}

export class UpdateLog {
  /** Fichiers lus ou ecrits par cette session : leur contenu est dans l'etat. */
  private readonly seen = new Set<string>()
  private pending: Uint8Array[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private writing: Promise<void> = Promise.resolve()
  private seq = 0
  private disposed = false

  constructor(
    private readonly fs: IVaultFileSystem,
    readonly dir: string,
    private readonly sessionId: string,
    private readonly options: UpdateLogOptions,
  ) {}

  /** Nom d'un fichier du journal (pour reconnaitre les evenements du disque). */
  static isLogFile(name: string): boolean {
    return name.endsWith(UPDATE_EXT) || name.endsWith(STATE_EXT)
  }

  /** Vrai si ce fichier a deja ete lu ou ecrit ici. */
  hasSeen(name: string): boolean {
    return this.seen.has(name)
  }

  /** Vrai si le journal ne contient encore rien (aucun fichier lu ni ecrit). */
  get isEmpty(): boolean {
    return this.seen.size === 0 && this.pending.length === 0
  }

  /** Lit les fichiers que cette session ne connait pas encore. */
  async readNew(): Promise<Uint8Array[]> {
    if (!(await this.fs.exists(this.dir))) return []
    const entries = await this.fs.list(this.dir)
    const out: Uint8Array[] = []
    for (const e of entries) {
      if (e.kind !== 'file') continue
      const name = e.path.slice(e.path.lastIndexOf('/') + 1)
      if (!UpdateLog.isLogFile(name) || this.seen.has(name)) continue
      try {
        out.push(await this.fs.readBytes(e.path))
        this.seen.add(name)
      } catch {
        // Efface entre la liste et la lecture (compaction d'une autre
        // session) : son contenu est dans un etat compacte, lu a son tour.
      }
    }
    return out
  }

  /** Ajoute une modification locale ; ecrite apres le delai de regroupement. */
  append(update: Uint8Array): void {
    if (this.disposed) return
    this.pending.push(update)
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush().catch(err => this.options.onError(err))
    }, this.options.persistMs)
  }

  /** Ecrit tout de suite ce qui attend. Rend quand c'est sur le disque. */
  flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    const next = this.writing.then(() => this.writePending())
    this.writing = next.catch(() => {})
    return next
  }

  /** Compacte si le journal a plusieurs fichiers : l'etat complet en un seul. */
  compact(force = false): Promise<void> {
    const next = this.writing.then(async () => {
      await this.writePending()
      if (this.seen.size <= 1 || (!force && this.seen.size < COMPACT_AFTER)) return
      await this.writeCompacted()
    })
    this.writing = next.catch(() => {})
    return next
  }

  /** Efface tout le journal (document supprime pour de bon). */
  async destroy(): Promise<void> {
    this.dispose()
    await this.writing
    if (await this.fs.exists(this.dir)) await this.fs.remove(this.dir)
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
  }

  // ── Interne ──────────────────────────────────────────────────────────────

  private nextName(ext: string): string {
    return `${Date.now().toString(36)}-${this.sessionId}-${(this.seq++).toString(36)}${ext}`
  }

  private async writePending(): Promise<void> {
    if (this.pending.length === 0) return
    const batch = this.pending
    this.pending = []
    const merged = batch.length === 1 ? batch[0] : Y_.mergeUpdates(batch) as Uint8Array
    const name = this.nextName(UPDATE_EXT)
    this.seen.add(name)
    try {
      await this.fs.writeBytes(`${this.dir}/${name}`, merged)
    } catch (err) {
      // Rien de perdu : le lot repart a la prochaine ecriture.
      this.seen.delete(name)
      this.pending.unshift(merged)
      throw err
    }
    if (this.seen.size >= COMPACT_AFTER) await this.writeCompacted()
  }

  private async writeCompacted(): Promise<void> {
    const old = [...this.seen]
    const name = this.nextName(STATE_EXT)
    await this.fs.writeBytes(`${this.dir}/${name}`, this.options.fullState())
    this.seen.add(name)
    for (const f of old) {
      this.seen.delete(f)
      try { await this.fs.remove(`${this.dir}/${f}`) } catch { /* deja efface ailleurs */ }
    }
  }
}
