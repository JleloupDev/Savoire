// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Texte extrait sur le poste, publie pour le serveur.
//
// Le pair indexeur du serveur ne fait tourner que les extracteurs des plugins
// officiels. Pour un fichier qu'un autre plugin sait lire (plugin de la
// communaute), c'est l'application d'un membre qui en tire le texte et le
// publie a cote du fichier, dans son annexe « texte » (un document CRDT
// rattache). Le serveur l'indexe alors comme le reste : le fichier devient
// cherchable par tous. Le texte publie vaut ce que vaut une note : il est
// ecrit par un membre qui a le droit d'ecrire.
import { EXTRACTED_TEXT_ANNEX, MAX_EXTRACT_BYTES, extractedToMarkdown, type ExtractorSpec, type ISharedTree } from '@savoire/plugin-api'
import { annexDocId } from './SessionTrees'
import type { IVaultSyncSession } from './contracts'

export interface ExtractedTextPublisherOptions {
  /** Regroupement des changements du repertoire (ms). Defaut : 3000. */
  delayMs?: number
  /** Attente du contenu deja publie d'une annexe (ms). Defaut : 1500. */
  settleMs?: number
}

export class ExtractedTextPublisher {
  private timer: ReturnType<typeof setTimeout> | null = null
  private running: Promise<void> | null = null
  private again = false
  private stopped = false
  private off: (() => void) | null = null
  /** Fichiers deja publies dans cette session (id -> extracteur@version). */
  private readonly done = new Map<string, string>()

  constructor(
    private readonly session: IVaultSyncSession,
    private readonly extractorOf: (path: string) => ExtractorSpec | undefined,
    private readonly canWrite: () => boolean,
    private readonly options: ExtractedTextPublisherOptions = {},
  ) {}

  start(): () => void {
    this.off = this.session.directory.onChange(() => this.schedule())
    this.schedule()
    return () => this.stop()
  }

  stop(): void {
    this.stopped = true
    this.off?.()
    if (this.timer) clearTimeout(this.timer)
  }

  /** Une passe : publie le texte des fichiers qui n'en ont pas (ou d'un extracteur plus ancien). */
  async pass(): Promise<number> {
    if (!this.canWrite()) return 0
    let published = 0
    for (const doc of this.session.directory.getAll()) {
      if (this.stopped) break
      // Seuls les fichiers envoyes (binaires) : un document CRDT s'indexe par son texte.
      if (!doc.binary || doc.path.startsWith('.trash/')) continue
      const spec = this.extractorOf(doc.path)
      // Officiel : le serveur s'en charge lui-meme.
      if (!spec || spec.official) continue
      const tag = `${spec.id}@${spec.version ?? 1}`
      if (this.done.get(doc.id) === tag) continue
      try {
        if (await this.publish(doc.id, doc.path, spec, tag)) published++
        this.done.set(doc.id, tag)
      } catch (err) {
        console.warn('[texte extrait] publication impossible', doc.path, err)
      }
    }
    return published
  }

  /** Ecrit le texte d'un fichier dans son annexe, sauf s'il y est deja (meme extracteur). */
  private async publish(fileId: string, path: string, spec: ExtractorSpec, tag: string): Promise<boolean> {
    const id = annexDocId(fileId, EXTRACTED_TEXT_ANNEX)
    await this.session.registerDocuments([id])
    const crdt = this.session.openDocument(id)
    try {
      const tree = this.session.openTree(id)
      // Le contenu connu arrive apres l'ouverture : attendre un instant l'extracteur deja publie.
      if (await waitForValue(tree, 'extractor', tag, this.options.settleMs ?? 1500)) return false
      const { bytes } = await this.session.files.readBytes(fileId)
      if (bytes.length > MAX_EXTRACT_BYTES) return false
      const content = await spec.extract(bytes, { path })
      tree.transact(() => {
        tree.root.set('markdown', extractedToMarkdown(content))
        tree.root.set('extractor', tag)
      })
      // Le chemin qui ne perd rien : un document ferme aussitot ne garde pas ses envois en vol.
      await this.session.mergeDocumentState(id, crdt.getSnapshot())
      return true
    } finally {
      this.session.closeDocument(id)
    }
  }

  /** Relancer une passe (un extracteur est arrive). */
  refresh(): void {
    this.schedule()
  }

  private schedule(): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.running) { this.again = true; return }
      this.running = this.pass().then(() => undefined, () => undefined).finally(() => {
        this.running = null
        if (this.again) { this.again = false; this.schedule() }
      })
    }, this.options.delayMs ?? 3000)
  }
}

/** La valeur attendue arrive-t-elle dans l'arbre avant le delai ? */
function waitForValue(tree: ISharedTree, key: string, value: string, ms: number): Promise<boolean> {
  if (tree.root.get(key) === value) return Promise.resolve(true)
  return new Promise(resolve => {
    const done = (ok: boolean) => { clearTimeout(timer); off(); resolve(ok) }
    const off = tree.onChange(() => { if (tree.root.get(key) === value) done(true) })
    const timer = setTimeout(() => done(false), ms)
  })
}
