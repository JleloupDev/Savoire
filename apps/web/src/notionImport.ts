// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Import Notion par la connexion (ADR-035), branche sur le vault ouvert.
//
// Le travail est dans NotionImportJob (@savoire/application). Ici : ou il
// ecrit (l'API des plugins du vault ouvert : documents, arbres partages,
// pieces jointes, types des proprietes), ou il garde son etat (ce poste,
// par vault), et ce que la personne voit (une notification avec sa barre
// de progression, l'etat pour la fenetre d'import).
//
// Un import en cours suit le vault : changer de vault le met en pause, le
// rouvrir le reprend.
import {
  NotionClient, NotionImportJob,
  type ImportedBaseManifest, type NotionApiImportReport, type NotionImportProgress, type NotionImportState,
  type NotionImportStore, type NotionImportTarget, type PageNode,
} from '@savoire/application'
import type { PluginAPI } from '@savoire/plugin-api'
import { BASE_LOT_COUNT } from '@savoire/plugin-api'
import { ManifestStore } from '@savoire/plugin-base'
import { pageToMarkdown } from '@savoire/plugin-page'
import { pmToInit } from '@savoire/plugin-page/adapter'
import { idAfterCreate } from '@savoire/plugin-runtime'
import { notifyProgress, type ProgressToast } from '@savoire/notifications'
import type { NotionBridge, NotionWorkspace } from './notionConnection'

const STATE_KEY = 'savoire-notion-import:'

export interface NotionImportStatus {
  /** Espace Notion connecte (null : pas connecte ; undefined : pas encore lu). */
  workspace: NotionWorkspace | null | undefined
  running: boolean
  progress: NotionImportProgress | null
  /** Un import commence dans ce vault et pas fini. */
  pending: boolean
  report: NotionApiImportReport | null
  error: string | null
}

/** Etat d'un import, garde sur ce poste pour un vault. */
export function localImportStore(vaultId: string, storage: Storage = localStorage): NotionImportStore {
  const key = STATE_KEY + vaultId
  return {
    async load() {
      try {
        const raw = storage.getItem(key)
        return raw ? (JSON.parse(raw) as NotionImportState) : null
      } catch {
        return null
      }
    },
    async save(state) {
      storage.setItem(key, JSON.stringify(state))
    },
  }
}

/**
 * Le vault ouvert, vu par l'import. `guard` : appele avant chaque ecriture,
 * leve si le vault a change entre-temps (l'objet sera retente a la reprise).
 */
export function pluginApiTarget(api: PluginAPI, guard: () => void = () => {}): NotionImportTarget {
  const vault = api.vault
  const need = <T>(v: T | undefined, what: string): T => {
    guard()
    if (v === undefined) throw new Error(`Ce vault ne permet pas ${what}.`)
    return v
  }
  async function withTree(docId: string, fn: (tree: Awaited<ReturnType<NonNullable<typeof vault.openTree>>>) => void): Promise<void> {
    const open = need(vault.openTree, 'd’écrire une page')
    const tree = await open(docId)
    try { fn(tree) } finally { vault.closeTree?.(docId) }
  }
  return {
    exists(path) {
      if (vault.resolveDocumentId(path)) return true
      const prefix = `${path.toLowerCase()}/`
      return (vault.getFileTree?.() ?? []).some(f => f.path.toLowerCase() === path.toLowerCase() || f.path.toLowerCase().startsWith(prefix))
    },
    async createFolder(path) {
      guard()
      await vault.createFolder?.(path)
    },
    async createDocument(path) {
      await need(vault.createFile, 'de créer de document').call(vault, path)
      return idAfterCreate(api, path)
    },
    async writePage(docId, doc: PageNode) {
      await withTree(docId, tree => tree.transact(() => { tree.root.set('doc', pmToInit(doc)) }))
    },
    async writeNote(docId, text) {
      guard()
      if (vault.editText) await vault.editText(docId, () => text)
      else await vault.write(docId, text)
    },
    async writeBase(docId, manifest: ImportedBaseManifest, folder) {
      await withTree(docId, tree => {
        const store = new ManifestStore(tree, () => ({
          stored: false,
          source: { folder, filters: [] },
          columns: manifest.columns,
          views: manifest.views,
          lotCount: BASE_LOT_COUNT,
          lots: [],
        }))
        // La premiere ecriture pose tout le manifeste (colonnes et vues).
        store.setSource({ folder })
      })
    },
    async writeAttachment(notePath, name, bytes) {
      const upload = need(vault.uploadAttachment, 'd’enregistrer de fichier')
      return upload.call(vault, new File([bytes as BlobPart], name), { notePath })
    },
    declareProperties(defs) {
      const props = api.properties
      if (!props) return
      // Un type deja choisi dans le vault reste le sien.
      for (const def of defs) if (!props.get(def.key)) props.set(def)
    },
    pageToMarkdown: doc => pageToMarkdown(doc),
  }
}

function phaseText(p: NotionImportProgress): string {
  if (p.phase === 'plan') return p.done ? `Inventaire : ${p.done} objet(s) trouvé(s)…` : 'Inventaire des pages partagées…'
  if (p.phase === 'skeleton') return `Arborescence : ${p.done} / ${p.total}`
  if (p.phase === 'fill') return `${p.done} / ${p.total}${p.current ? ` · ${p.current}` : ''}`
  return 'Terminé.'
}

/** Le rapport, en une phrase. */
export function reportText(r: NotionApiImportReport): string {
  const parts = [`${r.pages} page(s)`, `${r.bases} base(s)`, `${r.rows} ligne(s)`, `${r.files} fichier(s)`]
  let text = parts.join(', ') + '.'
  const skipped = Object.values(r.unsupported).reduce((a, b) => a + b, 0)
  if (skipped) text += ` ${skipped} bloc(s) non importé(s).`
  if (r.failed.length) text += ` ${r.failed.length} élément(s) en échec, retentés à la reprise.`
  return text
}

export class NotionImportService {
  private vaultId: string | null = null
  private job: NotionImportJob | null = null
  private toast: ProgressToast | null = null
  private readonly listeners = new Set<(s: NotionImportStatus) => void>()
  private current: NotionImportStatus = { workspace: undefined, running: false, progress: null, pending: false, report: null, error: null }

  constructor(private readonly bridge: NotionBridge, private readonly api: () => PluginAPI | undefined) {
    void this.refreshWorkspace()
  }

  get status(): NotionImportStatus {
    return this.current
  }

  subscribe(cb: (s: NotionImportStatus) => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  private set(patch: Partial<NotionImportStatus>): void {
    this.current = { ...this.current, ...patch }
    for (const cb of this.listeners) cb(this.current)
  }

  async refreshWorkspace(): Promise<void> {
    try {
      this.set({ workspace: await this.bridge.status() })
    } catch {
      this.set({ workspace: null })
    }
  }

  available(): Promise<boolean> {
    return this.bridge.available()
  }

  async connect(): Promise<NotionWorkspace> {
    this.set({ error: null })
    try {
      const ws = await this.bridge.connect()
      this.set({ workspace: ws })
      return ws
    } catch (err) {
      this.set({ error: err instanceof Error ? err.message : String(err) })
      throw err
    }
  }

  async disconnect(): Promise<void> {
    this.pause()
    await this.bridge.disconnect()
    this.set({ workspace: null })
  }

  /** Le vault ouvert change : l'import en cours s'arrete ; celui du nouveau vault reprend. */
  attachVault(vaultId: string | null): void {
    if (vaultId === this.vaultId) return
    this.pause()
    this.vaultId = vaultId
    this.set({ pending: false, report: null, progress: null, error: null })
    if (!vaultId) return
    void localImportStore(vaultId).load().then(state => {
      if (this.vaultId !== vaultId) return
      const pending = !!state && !state.finishedAt
      this.set({ pending })
      if (pending && this.current.workspace) void this.start()
    })
  }

  /** Lance un import (ou reprend celui de ce vault). `root` : dossier du vault, pour un nouvel import. */
  async start(root?: string): Promise<void> {
    const api = this.api()
    const vaultId = this.vaultId
    if (!api || !vaultId) throw new Error('Ouvrez un vault pour y importer Notion.')
    if (this.job) return
    const ws = this.current.workspace
    if (!ws) throw new Error('Connectez d’abord Notion.')
    const guard = () => { if (this.vaultId !== vaultId) throw new Error('Le vault a changé : import en pause.') }
    const job = new NotionImportJob(new NotionClient(this.bridge.api), this.bridge.files, pluginApiTarget(api, guard), localImportStore(vaultId))
    this.job = job
    const name = ws.workspaceName || 'Notion'
    const toast = this.toast = notifyProgress(`Import Notion « ${name} »`, 'Inventaire des pages partagées…')
    this.set({ running: true, pending: true, error: null, report: null })
    const off = job.onProgress(p => {
      this.set({ progress: p })
      toast.update(p.phase === 'fill' && p.total ? p.done / p.total : null, phaseText(p))
    })
    try {
      const report = await job.run({ root: root ?? name, workspace: name })
      const finished = !!(await localImportStore(vaultId).load())?.finishedAt
      this.set({ report, pending: !finished })
      if (finished) toast.succeed(`Import Notion « ${name} » terminé`, reportText(report))
      else if (report.failed.length && this.job === job) toast.fail(`Import Notion « ${name} » incomplet`, reportText(report))
      else toast.succeed(`Import Notion « ${name} » en pause`, 'Il reprendra à la prochaine ouverture de ce vault.')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.set({ error: message })
      toast.fail('Import Notion impossible', message)
    } finally {
      off()
      if (this.job === job) this.job = null
      if (this.toast === toast) this.toast = null
      this.set({ running: false })
    }
  }

  /** Met en pause (apres l'objet en cours). */
  pause(): void {
    this.job?.stop()
    this.job = null
  }
}
