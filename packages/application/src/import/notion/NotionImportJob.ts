// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Import progressif d'un espace Notion dans le vault ouvert (ADR-035).
//
// Trois temps :
//   1. le plan : tout ce que la personne a partage (recherche, lignes des
//      bases), et le chemin de chaque objet dans le vault ;
//   2. le squelette : dossiers et documents vides, crees d'un coup. Toute
//      l'arborescence est la en quelques secondes, et les liens entre pages
//      ont deja leur cible ;
//   3. le remplissage, page par page, au debit de Notion : contenu des pages,
//      images, manifestes et lignes des bases. Les pages du haut d'abord.
//
// L'etat est garde apres chaque objet (NotionImportStore) : un import
// interrompu (fermeture, vault change) reprend ou il s'etait arrete. Un objet
// en echec est retente a la reprise suivante ; les autres continuent.
//
// Ou va quoi :
//   page              « Dossier/Titre.page », ses sous-pages dans « Dossier/Titre/ » ;
//   base              « Dossier/Nom.base », ses lignes dans « Dossier/Nom/ » ;
//   ligne de base     « Dossier/Nom/Titre.md » : valeurs en frontmatter, contenu
//                     en Markdown (les lignes d'une base sont des notes, ADR-027) ;
//   image, fichier    dans le dossier de la page qui le contient.

import type { PropertyDef } from '@savoire/plugin-api'
import { frontmatter, type YamlValue } from '../NotionImport'
import { NotionApiError, type NotionClient, type NotionSearchResult } from './NotionClient'
import { blocksWithFiles, normalizeId, notionBlocksToPage, plainText, type NotionBlock, type NotionRichText, type PageNode } from './notionBlocks'
import {
  baseManifestOf, pageTitleOf, propertyDefs, propertyValues,
  type ImportedBaseManifest, type NotionPropertyValue, type NotionSchemaProperty, type NotionView,
} from './notionBases'

/** Ou ecrire : le vault ouvert, vu par l'import. */
export interface NotionImportTarget {
  /** Un document ou un dossier existe deja a ce chemin. */
  exists(path: string): boolean
  createFolder(path: string): Promise<void>
  /** Cree un document vide ; rend son id. */
  createDocument(path: string): Promise<string>
  /** Contenu d'une page (.page). */
  writePage(docId: string, doc: PageNode): Promise<void>
  /** Texte d'une note (.md). */
  writeNote(docId: string, text: string): Promise<void>
  /** Manifeste d'une base ; `folder` : dossier de ses lignes. */
  writeBase(docId: string, manifest: ImportedBaseManifest, folder: string): Promise<void>
  /**
   * Enregistre un fichier d'un document, dans son dossier (« Dossier/Page/ »),
   * sous ce nom ou un nom libre proche. Rend le chemin ecrit.
   */
  writeAttachment(notePath: string, name: string, bytes: Uint8Array): Promise<string>
  /** Declare les types des proprietes d'une base pour tout le vault. */
  declareProperties(defs: PropertyDef[]): void
  /** Markdown d'un document de page (corps d'une ligne de base). */
  pageToMarkdown(doc: PageNode): string
}

/** Fichiers des pages (adresses signees de Notion). */
export interface NotionFilePort {
  download(url: string): Promise<Uint8Array>
}

export interface NotionImportStore {
  load(): Promise<NotionImportState | null>
  save(state: NotionImportState): Promise<void>
}

export type NotionItemKind = 'page' | 'base' | 'row'

export interface NotionImportItem {
  /** Identifiant Notion, sans tirets. */
  id: string
  kind: NotionItemKind
  title: string
  /** Chemin dans le vault, extension comprise. */
  path: string
  /** Base : sa source de donnees ; ligne : la base qui la contient. */
  dataSource?: string
  /** Base : la base Notion (conteneur des vues). */
  database?: string
  /** Profondeur dans l'arborescence (0 : a la racine de l'import). */
  depth: number
  status: 'planned' | 'created' | 'filled' | 'failed'
  docId?: string
  error?: string
}

export interface NotionImportState {
  version: 1
  /** Dossier du vault qui recoit l'import. */
  root: string
  workspace: string
  startedAt: string
  finishedAt?: string
  items: Record<string, NotionImportItem>
  /** Alias -> item : une base Notion (conteneur) vers sa source de donnees. */
  aliases: Record<string, string>
  warnings: string[]
  unsupported: Record<string, number>
  files: number
}

export interface NotionImportProgress {
  phase: 'plan' | 'skeleton' | 'fill' | 'done'
  done: number
  total: number
  /** Titre de l'objet en cours. */
  current?: string
}

export interface NotionApiImportReport {
  pages: number
  bases: number
  rows: number
  files: number
  failed: { title: string; error: string }[]
  warnings: string[]
  unsupported: Record<string, number>
}

const EXT: Record<NotionItemKind, string> = { page: '.page', base: '.base', row: '.md' }

const stem = (path: string) => path.replace(/\.(page|base|md)$/i, '')

/** Nom de fichier propre (les memes interdits que les sous-pages). */
export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|#^[\]]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 120).trim() || 'Sans titre'
}

function titleOf(r: NotionSearchResult): string {
  if (r.object === 'page') return pageTitleOf(r.properties as Record<string, NotionPropertyValue> | undefined)
  return plainText(r.title as NotionRichText[] | undefined).trim()
}

function alive(r: NotionSearchResult): boolean {
  return !r.in_trash && !r.archived
}

/** Parent d'un objet : page, base (source de donnees ou conteneur), bloc, ou rien. */
function parentOf(r: NotionSearchResult): { kind: 'page' | 'base' | 'block' | 'root'; id?: string } {
  const p = (r.object === 'data_source' ? (r.database_parent as NotionSearchResult['parent'] | undefined) ?? r.parent : r.parent) ?? {}
  if (p.type === 'page_id' && p.page_id) return { kind: 'page', id: normalizeId(p.page_id) }
  if (p.type === 'data_source_id' && p.data_source_id) return { kind: 'base', id: normalizeId(p.data_source_id) }
  if (p.type === 'database_id' && p.database_id) return { kind: 'base', id: normalizeId(p.database_id) }
  if (p.type === 'block_id' && p.block_id) return { kind: 'block', id: normalizeId(p.block_id) }
  return { kind: 'root' }
}

export class NotionImportJob {
  private state: NotionImportState | null = null
  private stopped = false
  private readonly listeners = new Set<(p: NotionImportProgress) => void>()
  /** Proprietes des lignes lues pendant le plan (evite de relire chaque page). */
  private readonly rowProps = new Map<string, Record<string, NotionPropertyValue>>()

  constructor(
    private readonly client: NotionClient,
    private readonly files: NotionFilePort,
    private readonly target: NotionImportTarget,
    private readonly store: NotionImportStore,
  ) {}

  onProgress(cb: (p: NotionImportProgress) => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  /** Arrete apres l'objet en cours ; l'etat garde permet de reprendre. */
  stop(): void {
    this.stopped = true
  }

  private emit(p: NotionImportProgress): void {
    for (const cb of this.listeners) cb(p)
  }

  /** L'etat garde d'un import, s'il y en a un. */
  async saved(): Promise<NotionImportState | null> {
    return this.store.load()
  }

  /**
   * Lance ou reprend l'import. `root` : dossier du vault (un nouvel import
   * seulement) ; `workspace` : nom de l'espace Notion. Rend le rapport.
   */
  async run(options: { root?: string; workspace?: string } = {}): Promise<NotionApiImportReport> {
    this.stopped = false
    let state = await this.store.load()
    if (!state || state.finishedAt) {
      state = await this.plan(options.root ?? '', options.workspace ?? 'Notion')
      await this.store.save(state)
    }
    this.state = state
    await this.skeleton(state)
    await this.fill(state)
    if (!this.stopped && Object.values(state.items).every(i => i.status === 'filled')) {
      state.finishedAt = new Date().toISOString()
      await this.store.save(state)
      this.emit({ phase: 'done', done: this.total(state), total: this.total(state) })
    }
    return this.report(state)
  }

  private total(state: NotionImportState): number {
    return Object.keys(state.items).length
  }

  report(state: NotionImportState = this.state!): NotionApiImportReport {
    const items = Object.values(state.items)
    const filled = (k: NotionItemKind) => items.filter(i => i.kind === k && i.status === 'filled').length
    return {
      pages: filled('page'),
      bases: filled('base'),
      rows: filled('row'),
      files: state.files,
      failed: items.filter(i => i.status === 'failed').map(i => ({ title: i.title, error: i.error ?? '' })),
      warnings: state.warnings,
      unsupported: state.unsupported,
    }
  }

  // ── 1. Plan ─────────────────────────────────────────────────────────────

  private async plan(root: string, workspace: string): Promise<NotionImportState> {
    this.emit({ phase: 'plan', done: 0, total: 0 })
    const found = (await this.client.search()).filter(alive)
    const objects = new Map<string, NotionSearchResult>()
    const aliases: Record<string, string> = {}
    for (const r of found) {
      if (r.object === 'page' || r.object === 'data_source') objects.set(normalizeId(r.id), r)
      if (r.object === 'data_source' && r.parent?.database_id) aliases[normalizeId(r.parent.database_id)] = normalizeId(r.id)
    }
    // Lignes des bases : la requete de chaque source les donne toutes.
    for (const r of found.filter(x => x.object === 'data_source')) {
      try {
        for (const row of (await this.client.queryDataSource(r.id)).filter(alive)) {
          objects.set(normalizeId(row.id), row)
          if (row.properties) this.rowProps.set(normalizeId(row.id), row.properties as Record<string, NotionPropertyValue>)
        }
      } catch (err) {
        if (!(err instanceof NotionApiError)) throw err
      }
      this.emit({ phase: 'plan', done: objects.size, total: 0 })
    }
    for (const [id, r] of objects) if (r.object === 'page' && r.properties) this.rowProps.set(id, r.properties as Record<string, NotionPropertyValue>)

    // Parents des pages rangees dans un bloc (colonnes...) : on remonte jusqu'a la page.
    const blockParent = new Map<string, { kind: 'page' | 'base' | 'root'; id?: string }>()
    const resolveBlock = async (blockId: string): Promise<{ kind: 'page' | 'base' | 'root'; id?: string }> => {
      const known = blockParent.get(blockId)
      if (known) return known
      let id = blockId
      let result: { kind: 'page' | 'base' | 'root'; id?: string } = { kind: 'root' }
      for (let hop = 0; hop < 8; hop++) {
        let b: { parent?: NotionSearchResult['parent'] }
        try { b = await this.client.call('GET', `/v1/blocks/${id}`) } catch { break }
        const p = parentOf({ object: 'page', id, parent: b.parent })
        if (p.kind === 'block' && p.id) { id = p.id; continue }
        result = p.kind === 'block' ? { kind: 'root' } : { kind: p.kind, id: p.id }
        break
      }
      blockParent.set(blockId, result)
      return result
    }

    const parents = new Map<string, { kind: 'page' | 'base' | 'root'; id?: string }>()
    for (const [id, r] of objects) {
      let p: { kind: 'page' | 'base' | 'block' | 'root'; id?: string } = parentOf(r)
      if (p.kind === 'block' && p.id) p = await resolveBlock(p.id)
      if (p.kind === 'base' && p.id && aliases[p.id]) p = { kind: 'base', id: aliases[p.id] }
      // Parent absent de l'import (non partage) : a la racine.
      if ((p.kind === 'page' || p.kind === 'base') && (!p.id || !objects.has(p.id))) p = { kind: 'root' }
      parents.set(id, p as { kind: 'page' | 'base' | 'root'; id?: string })
    }

    // Chemins, parents d'abord ; noms uniques par dossier (casse ignoree).
    const used = new Map<string, Set<string>>()
    const items: Record<string, NotionImportItem> = {}
    const rootFolder = root.replace(/^\/+|\/+$/g, '')
    const claim = (folder: string, name: string, ext: string): string => {
      const set = used.get(folder) ?? new Set<string>()
      used.set(folder, set)
      let candidate = name
      for (let n = 2; set.has(candidate.toLowerCase()) || this.target.exists(`${folder}${candidate}${ext}`); n++) candidate = `${name} (${n})`
      set.add(candidate.toLowerCase())
      return `${folder}${candidate}${ext}`
    }
    const visiting = new Set<string>()
    const place = (id: string): NotionImportItem => {
      const done = items[id]
      if (done) return done
      const r = objects.get(id)!
      const p = parents.get(id) ?? { kind: 'root' }
      let folder = rootFolder ? `${rootFolder}/` : ''
      let depth = 0
      visiting.add(id)
      if (p.id && !visiting.has(p.id)) {
        const parent = place(p.id)
        folder = `${stem(parent.path)}/`
        depth = parent.depth + 1
      }
      visiting.delete(id)
      const kind: NotionItemKind = r.object === 'data_source' ? 'base' : p.kind === 'base' ? 'row' : 'page'
      const title = titleOf(r) || (kind === 'base' ? 'Base sans titre' : 'Sans titre')
      const item: NotionImportItem = { id, kind, title, path: claim(folder, safeFileName(title), EXT[kind]), depth, status: 'planned' }
      if (kind === 'base') {
        item.dataSource = id
        const db = r.parent?.database_id
        if (db) item.database = normalizeId(db)
      }
      if (kind === 'row' && p.id) item.dataSource = p.id
      items[id] = item
      return item
    }
    for (const id of objects.keys()) place(id)
    this.emit({ phase: 'plan', done: Object.keys(items).length, total: Object.keys(items).length })
    return {
      version: 1, root: rootFolder, workspace, startedAt: new Date().toISOString(),
      items, aliases, warnings: [], unsupported: {}, files: 0,
    }
  }

  // ── 2. Squelette ────────────────────────────────────────────────────────

  private ordered(state: NotionImportState): NotionImportItem[] {
    return Object.values(state.items).sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path))
  }

  private async ensureFolder(path: string, made: Set<string>): Promise<void> {
    const parts = path.split('/').filter(Boolean)
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join('/')
      if (made.has(p)) continue
      made.add(p)
      if (!this.target.exists(p)) await this.target.createFolder(p)
    }
  }

  private async skeleton(state: NotionImportState): Promise<void> {
    const todo = this.ordered(state).filter(i => i.status === 'planned' || (i.status === 'failed' && !i.docId))
    const made = new Set<string>()
    let done = 0
    for (const item of todo) {
      if (this.stopped) return
      this.emit({ phase: 'skeleton', done, total: todo.length, current: item.title })
      try {
        const folder = item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/')) : ''
        if (folder) await this.ensureFolder(folder, made)
        item.docId = await this.target.createDocument(item.path)
        // Le dossier des lignes d'une base existe tout de suite (vue vide sinon).
        if (item.kind === 'base') await this.ensureFolder(stem(item.path), made)
        item.status = 'created'
        delete item.error
      } catch (err) {
        item.status = 'failed'
        item.error = errorText(err)
      }
      done++
    }
    await this.store.save(state)
  }

  // ── 3. Remplissage ──────────────────────────────────────────────────────

  /** Cible d'un lien vers un objet importe (page, ligne : sans extension ; base : avec). */
  private linkTarget(state: NotionImportState, notionId: string): string | null {
    const item = state.items[notionId] ?? state.items[state.aliases[notionId] ?? '']
    if (!item) return null
    return item.kind === 'base' ? item.path : stem(item.path)
  }

  private async fill(state: NotionImportState): Promise<void> {
    const todo = this.ordered(state).filter(i => i.docId && i.status !== 'filled')
    const total = this.total(state)
    let done = total - todo.length
    for (const item of todo) {
      if (this.stopped) return
      this.emit({ phase: 'fill', done, total, current: item.title })
      try {
        if (item.kind === 'base') await this.fillBase(state, item)
        else await this.fillPage(state, item)
        item.status = 'filled'
        delete item.error
      } catch (err) {
        item.status = 'failed'
        item.error = errorText(err)
      }
      done++
      await this.store.save(state)
    }
    this.emit({ phase: 'fill', done, total })
  }

  /** Telecharge les fichiers des blocs, dans le dossier de la page. */
  private async downloadFiles(state: NotionImportState, item: NotionImportItem, blocks: NotionBlock[]): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    for (const f of blocksWithFiles(blocks)) {
      try {
        const bytes = await this.files.download(f.url)
        out.set(f.block.id, await this.target.writeAttachment(item.path, f.name, bytes))
        state.files++
      } catch (err) {
        state.warnings.push(`« ${item.title} » : fichier ${f.name} non téléchargé (${errorText(err)}).`)
      }
    }
    return out
  }

  private async fillPage(state: NotionImportState, item: NotionImportItem): Promise<void> {
    const blocks = await this.client.blockTree(item.id)
    const files = await this.downloadFiles(state, item, blocks)
    const { doc, unsupported } = notionBlocksToPage(blocks, {
      linkTarget: id => this.linkTarget(state, id),
      fileOf: id => files.get(id) ?? null,
    })
    for (const [type, n] of Object.entries(unsupported)) state.unsupported[type] = (state.unsupported[type] ?? 0) + n
    if (item.kind === 'page') {
      await this.target.writePage(item.docId!, doc)
      return
    }
    // Ligne de base : valeurs en frontmatter, contenu en Markdown.
    let props = this.rowProps.get(item.id)
    if (!props) props = ((await this.client.call<{ properties?: Record<string, NotionPropertyValue> }>('GET', `/v1/pages/${item.id}`)).properties) ?? {}
    const values = propertyValues(props, { linkTarget: id => this.linkTarget(state, id) })
      .filter((v): v is [string, YamlValue] => v[1] !== null)
    const body = this.target.pageToMarkdown(doc)
    await this.target.writeNote(item.docId!, frontmatter(values) + (body.trim() ? body : ''))
  }

  private async fillBase(state: NotionImportState, item: NotionImportItem): Promise<void> {
    const ds = await this.client.dataSource(item.dataSource ?? item.id)
    const schema = (ds.properties ?? {}) as Record<string, NotionSchemaProperty>
    let views: NotionView[] = []
    if (item.database) {
      try {
        views = (await this.client.views(item.database)) as unknown as NotionView[]
        // Une vue d'une autre source de la meme base n'est pas la sienne.
        views = views.filter(v => {
          const src = (v as { data_source_id?: string }).data_source_id
          return !src || normalizeId(src) === item.id
        })
      } catch (err) {
        if (!(err instanceof NotionApiError)) throw err
        state.warnings.push(`Base « ${item.title} » : vues illisibles, un tableau par défaut.`)
      }
    }
    const manifest = baseManifestOf(item.title, schema, views)
    state.warnings.push(...manifest.warnings)
    // Une relation vise la base importee de sa source Notion (son document .base).
    const baseOf = (notionId: string) => Object.values(state.items)
      .find(i => i.docId && i.kind === 'base' && (i.id === notionId || i.dataSource === notionId || i.database === notionId))?.docId
    this.target.declareProperties(propertyDefs(schema, { baseOf }))
    await this.target.writeBase(item.docId!, manifest, stem(item.path))
  }
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
