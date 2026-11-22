// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Les fichiers qui font tomber le fil d'indexation. Un extracteur (OCR, PDF,
// Office...) fait tourner du code de bibliotheque : une erreur qui lui
// echappe, ou un manque de memoire, arrete le fil. Le fil est relance, le
// flux rejoue, et la meme lecture le refait tomber, sans fin : la recherche
// et les IA ne recoivent plus que « Fil d'indexation en redemarrage ».
//
// Garde-fou : chaque lecture en cours est notee dans le journal du fil
// ({dataDir}/shard-{n}.reading.json), ecrit avant l'extraction et mis a jour
// apres. Un arret propre l'efface. Au demarrage, un journal reste en place
// veut dire que le fil (ou le processus) est tombe pendant ces lectures :
// chaque fichier lu compte une chute. Apres QUARANTINE_AFTER chutes de suite
// (sans lecture menee a bout entre deux), le fichier est mis de cote : il est
// indexe par son nom seulement, et un rapport d'erreur part (ligne `error`
// du journal, donc GlitchTip ; metrique et alerte). Il est relu s'il change
// (empreinte), ou si son extracteur ou le pair changent de version.
//
// Etat par vault : {dataDir}/{vaultId}.quarantine.json, chemins compris (le
// volume des index contient deja tout le texte). Le journal du service, lui,
// ne donne que les ids et l'extension.
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Logger } from './log'
import { isVaultId } from './util'

/** Une lecture en cours, telle que le journal du fil la garde. */
export interface Reading {
  vault: string
  doc: string
  path: string
  bytes: number
  sha256: string
  extractor: string
  at: string
}

/** Un fichier pendant la lecture duquel le fil est tombe. */
export interface Suspect {
  path: string
  bytes: number
  sha256: string
  /** Extracteur et sa version (id@version). */
  extractor: string
  /** Version du pair. */
  version: string
  crashes: number
  firstAt: string
  lastAt: string
  cause?: string
  /** Mis de cote depuis. */
  quarantinedAt?: string
}

/** Fin du fil precedent, vue par le fil principal (code de sortie, erreur). */
export interface ShardExit {
  code?: number
  error?: string
}

interface Journal {
  pid: number
  reading: Reading[]
  error?: { message: string; stack?: string }
}

export interface QuarantineOptions {
  dataDir: string
  shard: number
  version: string
  /** Chutes de suite avant de mettre un fichier de cote. */
  after: number
  log: Logger
}

const MAX_STACK = 4000

function extOf(path: string): string {
  return /\.([a-z0-9]{1,8})$/i.exec(path)?.[1]?.toLowerCase() ?? ''
}

export class FileQuarantine {
  private readonly reading = new Map<number, Reading>()
  private nextId = 1
  private stopped = false
  /** Fichiers soupconnes ou mis de cote, par vault (charges a la demande). */
  private readonly vaults = new Map<string, Map<string, Suspect>>()

  constructor(private readonly opts: QuarantineOptions) {}

  private get journalFile(): string {
    return join(this.opts.dataDir, `shard-${this.opts.shard}.reading.json`)
  }

  private fileOf(vaultId: string): string {
    return join(this.opts.dataDir, `${vaultId}.quarantine.json`)
  }

  /**
   * Au demarrage du fil : l'etat des vaults du fil, puis les lectures
   * pendant lesquelles le fil precedent est tombe (journal laisse en place).
   */
  start(owns: (vaultId: string) => boolean, lastExit?: ShardExit): void {
    for (const name of readdirSync(this.opts.dataDir)) {
      const m = /^(.+)\.quarantine\.json$/.exec(name)
      if (m && isVaultId(m[1]) && owns(m[1]!)) this.load(m[1]!)
    }
    let journal: Journal | undefined
    try {
      journal = JSON.parse(readFileSync(this.journalFile, 'utf8')) as Journal
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.opts.log.warn('journal des lectures illisible', { err })
    }
    if (journal && Array.isArray(journal.reading)) {
      const cause = journal.error?.message
        ?? lastExit?.error
        ?? (lastExit?.code !== undefined ? `fil sorti avec le code ${lastExit.code}` : 'processus arrete net (memoire, signal KILL ?)')
      const seen = new Set<string>()
      for (const r of journal.reading) {
        const key = `${r.vault}/${r.doc}`
        if (seen.has(key) || !isVaultId(r.vault) || !owns(r.vault)) continue
        seen.add(key)
        this.blame(r, cause, journal.error?.stack)
      }
    }
    this.rm(this.journalFile)
  }

  /**
   * Avant de lire un fichier. Mis de cote (meme contenu, meme extracteur,
   * meme pair) : rendu, sans lecture. Sinon la lecture est notee au journal ;
   * `done` l'en retire (lecture menee a bout, reussie ou en erreur rattrapee).
   */
  begin(vaultId: string, doc: string, path: string, bytes: Uint8Array, extractor: string): { quarantined: Suspect } | { done: () => void } {
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const files = this.load(vaultId)
    const old = files.get(doc)
    if (old && !this.same(old, sha256, extractor)) {
      // Le fichier, son extracteur ou le pair ont change : on retente.
      files.delete(doc)
      this.save(vaultId)
    } else if (old?.quarantinedAt) {
      return { quarantined: old }
    }
    if (this.stopped) return { done: () => {} }
    const id = this.nextId++
    this.reading.set(id, { vault: vaultId, doc, path, bytes: bytes.length, sha256, extractor, at: new Date().toISOString() })
    this.writeJournal()
    return {
      done: () => {
        if (!this.reading.delete(id)) return
        this.writeJournal()
        // Lu sans tomber : plus soupconne.
        const s = files.get(doc)
        if (s && !s.quarantinedAt && files === this.vaults.get(vaultId)) {
          files.delete(doc)
          this.save(vaultId)
        }
      },
    }
  }

  /** Mis de cote (sans regarder le contenu) : pour le rendre a qui le demande. */
  quarantined(vaultId: string, doc: string): Suspect | undefined {
    const s = this.load(vaultId).get(doc)
    return s?.quarantinedAt ? s : undefined
  }

  /**
   * Exception non rattrapee, juste avant la sortie du fil : la cause va au
   * journal (synchrone), pour le rapport du prochain demarrage.
   */
  crashed(err: unknown): void {
    if (!this.reading.size) return
    const e = err as { message?: unknown; stack?: unknown } | null
    const message = String(e?.message ?? err)
    const stack = typeof e?.stack === 'string' ? e.stack.slice(0, MAX_STACK) : undefined
    this.writeJournal({ message, ...(stack ? { stack } : {}) })
  }

  /** Arret propre : rien n'est tombe. */
  stop(): void {
    this.stopped = true
    this.reading.clear()
    this.rm(this.journalFile)
  }

  /** Vault supprime (ou orphelin efface). */
  forget(vaultId: string): void {
    this.vaults.delete(vaultId)
    this.rm(this.fileOf(vaultId))
  }

  /** Fichiers mis de cote dans ce fil. */
  count(): number {
    let n = 0
    for (const files of this.vaults.values()) for (const s of files.values()) if (s.quarantinedAt) n++
    return n
  }

  private same(s: Suspect, sha256: string, extractor: string): boolean {
    return s.sha256 === sha256 && s.extractor === extractor && s.version === this.opts.version
  }

  private blame(r: Reading, cause: string, stack?: string): void {
    const files = this.load(r.vault)
    const now = new Date().toISOString()
    const old = files.get(r.doc)
    const same = !!old && this.same(old, r.sha256, r.extractor)
    if (same && old!.quarantinedAt) return
    const s: Suspect = same
      ? { ...old!, path: r.path, crashes: old!.crashes + 1, lastAt: now, cause }
      : { path: r.path, bytes: r.bytes, sha256: r.sha256, extractor: r.extractor, version: this.opts.version, crashes: 1, firstAt: now, lastAt: now, cause }
    const fields = {
      vault: r.vault, doc: r.doc, ext: extOf(r.path), bytes: r.bytes, extractor: r.extractor,
      sha256: r.sha256.slice(0, 16), crashes: s.crashes, after: this.opts.after,
    }
    if (s.crashes >= this.opts.after) {
      s.quarantinedAt = now
      // Le rapport d'erreur : une ligne `error` (GlitchTip si SAVOIRE_INDEXER_ERROR_DSN).
      this.opts.log.error(`fichier mis de cote : sa lecture (${r.extractor}) fait tomber le fil d indexation`, {
        ...fields, err: { name: 'IndexerCrashLoop', message: cause }, ...(stack ? { stack } : {}),
      })
    } else {
      this.opts.log.warn('le fil d indexation est tombe pendant la lecture d un fichier', { ...fields, cause })
    }
    files.set(r.doc, s)
    this.save(r.vault)
  }

  private load(vaultId: string): Map<string, Suspect> {
    let files = this.vaults.get(vaultId)
    if (files) return files
    files = new Map()
    try {
      const raw = JSON.parse(readFileSync(this.fileOf(vaultId), 'utf8')) as { files?: Record<string, Suspect> }
      for (const [doc, s] of Object.entries(raw.files ?? {})) if (s && typeof s.sha256 === 'string') files.set(doc, s)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.opts.log.warn('fichiers mis de cote illisibles', { vault: vaultId, err })
    }
    this.vaults.set(vaultId, files)
    return files
  }

  private save(vaultId: string): void {
    const files = this.vaults.get(vaultId)
    if (!files?.size) { this.rm(this.fileOf(vaultId)); return }
    this.write(this.fileOf(vaultId), { files: Object.fromEntries(files) })
  }

  private writeJournal(error?: Journal['error']): void {
    if (!this.reading.size && !error) { this.rm(this.journalFile); return }
    const journal: Journal = { pid: process.pid, reading: [...this.reading.values()], ...(error ? { error } : {}) }
    this.write(this.journalFile, journal)
  }

  /** Ecriture entiere ou rien (fichier temporaire puis renommage). */
  private write(file: string, value: unknown): void {
    try {
      writeFileSync(file + '.tmp', JSON.stringify(value))
      renameSync(file + '.tmp', file)
    } catch (err) {
      this.opts.log.warn('ecriture impossible', { file, err })
    }
  }

  private rm(file: string): void {
    try { rmSync(file, { force: true }) } catch (err) { this.opts.log.warn('suppression impossible', { file, err }) }
  }
}
