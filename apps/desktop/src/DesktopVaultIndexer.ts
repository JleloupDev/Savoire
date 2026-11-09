// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Indexeur de fond d'un vault du disque (ADR-027, etape 6) : le bureau a
// tous les fichiers, il indexe donc TOUT le vault dans son index SQLite
// (`.savoire/index.sqlite`, natif cote Rust), sans attendre qu'une note soit
// ouverte.
//
//  - premiere construction : chaque note est lue (fichier visible pour un
//    texte, etat CRDT pour une page, un dessin, une carte mentale), par lots
//    d'une transaction ; l'etat passe en `building` avec sa progression ;
//  - au redemarrage : chaque note garde la signature de sa source (chemin,
//    taille, date du fichier ; fichiers de son etat CRDT). Seules les notes
//    dont la signature a change sont relues : pas de reconstruction ;
//  - au fil de l'eau : la surveillance du disque (un fichier modifie, l'etat
//    d'un document non textuel), l'arborescence de la session (creation,
//    renommage, suppression, corbeille) et le texte des notes ouvertes
//    (editeur) ;
//  - les documents que Savoire n'edite pas (Word, Excel, PDF, images...) :
//    leur texte et leurs proprietes, tires par les EXTRACTEURS des plugins,
//    entrent dans l'index comme une note. Un extracteur qui arrive (plugin
//    installe) fait relire ces fichiers.
//
// La session et le systeme de fichiers sont decrits ici par ce qui sert :
// les tests passent un dossier simule.
import { NOTE_EXTENSIONS, extOf, isTrashPath, noteInputFromUpdates } from '@savoire/indexer-core'
import { MAX_EXTRACT_BYTES, extractedToMarkdown, type ExtractorSpec } from '@savoire/plugin-api'
import type { NoteInput } from '@savoire/indexer-core'
import type { ILocalIndex } from '@savoire/indexer-core/local'
import type { FileChange, FileEntry, IVaultFileSystem } from '@savoire/platform'

export interface DesktopIndexSources {
  fs: Pick<IVaultFileSystem, 'list' | 'readText' | 'stat'> & Partial<Pick<IVaultFileSystem, 'watch' | 'readBytes'>>
  /** Arborescence de la session : ids stables des documents. */
  directory: {
    getAll(): readonly { id: string; path: string }[]
    onChange(cb: () => void): () => void
  }
  /** Etat CRDT d'un document non textuel (IVaultSyncSession.readDocumentState). */
  readState(id: string): Promise<Uint8Array>
  /** Dossier de l'etat CRDT d'un document (`.savoire/crdt/<id>`). */
  stateDirOf(id: string): string
  /** Le fichier visible fait foi (texte). Defaut : .md et .outline. */
  isText?(path: string): boolean
  /** Extracteur d'un fichier qui n'est pas une note (plugins). Absent : aucun. */
  extractor?(path: string): ExtractorSpec | undefined
}

export interface DesktopIndexerOptions {
  /** Notes par transaction. Defaut : 100. */
  batchSize?: number
  /** Lectures en parallele. Defaut : 8. */
  concurrency?: number
  /** Regroupement des changements (ms). Defaut : 300. */
  debounceMs?: number
  /** Au-dela, l'etat passe en construction meme hors premiere construction. Defaut : 50. */
  buildingThreshold?: number
  onError?: (err: unknown) => void
}

interface Job {
  id: string
  path: string
  sig: string
}

const SAVOIRE = '.savoire/'
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set(['md', 'outline'])

/** Une note que l'index sait lire, hors corbeille. */
function indexable(path: string): boolean {
  return NOTE_EXTENSIONS.has(extOf(path)) && !isTrashPath(path)
}

function fileSig(e: FileEntry | null | undefined): string {
  return e ? `${e.size ?? '-'}:${e.mtimeMs ?? '-'}` : '-'
}

export class DesktopVaultIndexer {
  private stored: Map<string, string> | null = null
  private tail: Promise<unknown> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | null = null
  private fullPending = false
  private readonly changed = new Set<string>()
  private readonly unsubs: (() => void)[] = []
  private started = false
  private disposed = false
  private first = true

  constructor(
    private readonly index: ILocalIndex,
    private readonly sources: DesktopIndexSources,
    private readonly options: DesktopIndexerOptions = {},
  ) {}

  /** Premiere passe (construction ou reprise), puis suivi des changements. */
  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    this.unsubs.push(this.sources.directory.onChange(() => this.schedule(true)))
    const unwatch = this.sources.fs.watch?.(changes => this.onDisk(changes))
    if (unwatch) this.unsubs.push(unwatch)
    this.fullPending = true
    this.enqueue(() => this.flush())
  }

  /** Les extracteurs ont change (plugin installe ou retire) : tout est recompare. */
  extractorsChanged(): void {
    if (this.started) this.schedule(true)
  }

  /** Le texte a jour d'une note ouverte (editeur) : indexe tout de suite. */
  noteText(id: string, path: string, content: string): void {
    if (this.disposed || !indexable(path)) return
    // Sans signature : la projection du fichier sera relue, et signee, ensuite.
    this.enqueue(() => this.index.applyDocs([{ id, path, content }]))
  }

  /** Resolu quand tout ce qui est connu est indexe (tests, outils). */
  async whenIdle(): Promise<void> {
    for (;;) {
      const t = this.tail
      await t
      if (t === this.tail && !this.timer) return
      if (this.timer) await new Promise(r => setTimeout(r, (this.options.debounceMs ?? 300) + 5))
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    for (const u of this.unsubs.splice(0)) u()
  }

  // ── Changements ──────────────────────────────────────────────────────────

  private onDisk(changes: readonly FileChange[]): void {
    let any = false
    for (const c of changes) {
      // L'etat CRDT d'un document non textuel ; le reste de .savoire ne dit rien des notes.
      if (c.path.startsWith(SAVOIRE) && !c.path.startsWith(`${SAVOIRE}crdt/`)) continue
      this.changed.add(c.path)
      any = true
    }
    if (any) this.schedule(false)
  }

  private schedule(full: boolean): void {
    if (this.disposed) return
    if (full) this.fullPending = true
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.enqueue(() => this.flush())
    }, this.options.debounceMs ?? 300)
  }

  private enqueue(job: () => Promise<void>): void {
    this.tail = this.tail.then(async () => {
      if (this.disposed) return
      try {
        await job()
      } catch (err) {
        (this.options.onError ?? (e => console.warn('[index du bureau]', e)))(err)
      }
    })
  }

  private async flush(): Promise<void> {
    if (this.fullPending) {
      this.fullPending = false
      this.changed.clear()
      await this.reconcile()
    } else if (this.changed.size) {
      const paths = [...this.changed]
      this.changed.clear()
      await this.update(paths)
    }
  }

  // ── Signatures ───────────────────────────────────────────────────────────

  private isText(path: string): boolean {
    return this.sources.isText ? this.sources.isText(path) : TEXT_EXTENSIONS.has(extOf(path))
  }

  /** Un fichier que l'index lit par un extracteur (pas une note). */
  private extractorOf(path: string): ExtractorSpec | undefined {
    if (indexable(path) || isTrashPath(path) || !this.sources.fs.readBytes) return undefined
    return this.sources.extractor?.(path)
  }

  /** Lu par son fichier visible : un texte, ou un fichier extrait. */
  private byFile(path: string): boolean {
    return this.isText(path) || !!this.extractorOf(path)
  }

  /** Signature d'un fichier : extrait, elle porte l'extracteur et sa version. */
  private fileSignature(path: string, e: FileEntry | null | undefined): string {
    const x = this.extractorOf(path)
    return x ? `x|${path}|${fileSig(e)}|${x.id}@${x.version ?? 1}` : `f|${path}|${fileSig(e)}`
  }

  private known(path: string): boolean {
    return indexable(path) || !!this.extractorOf(path)
  }

  /** Signature d'un document non textuel : ses fichiers d'etat. */
  private stateSig(entries: readonly FileEntry[]): string {
    return entries
      .filter(e => e.kind === 'file')
      .map(e => `${e.path.slice(e.path.lastIndexOf('/') + 1)}:${fileSig(e)}`)
      .sort()
      .join(',')
  }

  private async signatures(): Promise<Map<string, string>> {
    this.stored ??= await this.index.sources()
    return this.stored
  }

  // ── Passe complete ───────────────────────────────────────────────────────

  /** Compare tout le dossier a l'index : ce qui manque ou a change est relu, ce qui a disparu est retire. */
  private async reconcile(): Promise<void> {
    const entries = await this.sources.fs.list('', { recursive: true })
    const files = new Map<string, FileEntry>()
    const states = new Map<string, FileEntry[]>()
    for (const e of entries) {
      if (e.kind !== 'file') continue
      files.set(e.path, e)
      if (e.path.startsWith(`${SAVOIRE}crdt/`)) {
        const dir = e.path.slice(0, e.path.lastIndexOf('/'))
        let list = states.get(dir)
        if (!list) states.set(dir, list = [])
        list.push(e)
      }
    }
    const docs = this.sources.directory.getAll().filter(d => this.known(d.path))
    const stored = await this.signatures()
    const indexed = await this.index.paths()
    const jobs: Job[] = []
    for (const d of docs) {
      const sig = this.byFile(d.path)
        ? this.fileSignature(d.path, files.get(d.path))
        : `c|${d.path}|${this.stateSig(states.get(this.sources.stateDirOf(d.id)) ?? [])}`
      if (stored.get(d.id) !== sig) jobs.push({ id: d.id, path: d.path, sig })
    }
    const current = new Set(docs.map(d => d.id))
    const gone = [...new Set([...stored.keys(), ...indexed.keys()])].filter(id => !current.has(id))
    if (gone.length) {
      await this.index.removeDocs(gone)
      for (const id of gone) stored.delete(id)
    }
    const initial = this.first && this.index.info.rebuildRequired
    this.first = false
    await this.run(jobs, initial)
    if (initial && !this.disposed) await this.index.markBuilt()
  }

  // ── Changements du disque ────────────────────────────────────────────────

  /** Quelques fichiers ont change : seules les notes concernees sont relues. */
  private async update(paths: readonly string[]): Promise<void> {
    const docs = this.sources.directory.getAll().filter(d => this.known(d.path))
    const byPath = new Map(docs.map(d => [d.path, d]))
    const byStateDir = new Map<string, { id: string; path: string }>()
    for (const d of docs) if (!this.byFile(d.path)) byStateDir.set(this.sources.stateDirOf(d.id), d)
    const stored = await this.signatures()
    const jobs: Job[] = []
    const seen = new Set<string>()
    for (const p of paths) {
      if (p.startsWith(SAVOIRE)) {
        const d = byStateDir.get(p.slice(0, p.lastIndexOf('/')))
        if (!d || seen.has(d.id)) continue
        seen.add(d.id)
        const sig = `c|${d.path}|${this.stateSig(await this.sources.fs.list(this.sources.stateDirOf(d.id)).catch(() => []))}`
        if (stored.get(d.id) !== sig) jobs.push({ ...d, sig })
        continue
      }
      const d = byPath.get(p)
      if (!d || !this.byFile(d.path) || seen.has(d.id)) continue
      seen.add(d.id)
      const sig = this.fileSignature(d.path, await this.sources.fs.stat(d.path).catch(() => null))
      if (stored.get(d.id) !== sig) jobs.push({ ...d, sig })
    }
    await this.run(jobs, false)
  }

  // ── Lecture et ecriture ─────────────────────────────────────────────────

  private async read(job: Job): Promise<NoteInput | null> {
    const extractor = this.extractorOf(job.path)
    if (extractor) {
      const stat = await this.sources.fs.stat(job.path)
      // Trop gros : signe sans le lire (son nom reste trouvable dans l'arbre).
      if (!stat || (stat.size ?? 0) > MAX_EXTRACT_BYTES) return null
      const bytes = await this.sources.fs.readBytes!(job.path)
      try {
        const content = await extractor.extract(bytes, { path: job.path })
        // Proprietes en frontmatter : interrogeables comme celles d'une note.
        return { id: job.id, path: job.path, content: extractedToMarkdown(content), frontmatter: true }
      } catch (err) {
        // Fichier abime : on le signe quand meme, il ne sera relu que s'il change.
        console.warn('[index du bureau] extraction impossible', job.path, err)
        return null
      }
    }
    if (this.isText(job.path)) {
      return { id: job.id, path: job.path, content: await this.sources.fs.readText(job.path) }
    }
    return noteInputFromUpdates(job.id, job.path, [await this.sources.readState(job.id)])
  }

  /** Relit et indexe ces notes, par lots ; `building` : etat en construction avec progression. */
  private async run(jobs: readonly Job[], building: boolean): Promise<void> {
    if (!jobs.length) return
    const show = building || jobs.length > (this.options.buildingThreshold ?? 50)
    const size = this.options.batchSize ?? 100
    const concurrency = Math.max(1, this.options.concurrency ?? 8)
    const stored = await this.signatures()
    let done = 0
    if (show) this.index.setState({ status: 'building', progress: 0 })
    try {
      for (let i = 0; i < jobs.length && !this.disposed; i += size) {
        const chunk = jobs.slice(i, i + size)
        const inputs: NoteInput[] = []
        const sigs: Record<string, string> = {}
        for (let j = 0; j < chunk.length; j += concurrency) {
          await Promise.all(chunk.slice(j, j + concurrency).map(async job => {
            try {
              const input = await this.read(job)
              if (input) inputs.push(input)
              // Type que l'index ne lit pas : signe quand meme, pour ne pas le relire.
              sigs[job.id] = job.sig
            } catch (err) {
              // Fichier disparu ou illisible : pas de signature, il sera retente.
              console.warn('[index du bureau] note illisible', job.path, err)
            }
          }))
        }
        await this.index.applyDocs(inputs, sigs)
        for (const [id, sig] of Object.entries(sigs)) stored.set(id, sig)
        done += chunk.length
        if (show) this.index.setState({ status: 'building', progress: Math.min(1, done / jobs.length) })
      }
    } finally {
      if (show) this.index.setState({ status: 'ready' })
    }
  }
}
