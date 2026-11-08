// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Cote Savoire d'un board : l'iframe isolee (frame.ts) et les seules choses
// qu'elle peut demander.
//
//   savoire.query(q)            requete declarative (IQueryEngine), une fois
//   savoire.watch(q, cb)        la meme, suivie en direct ; rend l'arret
//   savoire.open(path)          ouvre une note
//   savoire.setProperty(t, k, v) ecrit une propriete : d'une note (ligne-page),
//                                ou d'une ligne legere d'une base
//   savoire.createPage(base, title, values)  nouvelle ligne-page d'une base
//   savoire.createRow(base, title, values)   nouvelle ligne legere d'une base
//
// Dans une requete, `from` peut nommer une base comme dans un bloc
// ```base : { base: "Projets" } (nom, chemin ou id), ou simplement "Projets".
// Savoire la resout et ajoute son dossier de pages et son filtre de source.
//
// Ecritures : jamais en lecture seule ; la premiere de chaque board demande
// l'accord de la personne qui le regarde (le code est celui d'un autre
// membre) ; debit borne.
import type { ISharedTree, PluginAPI, PropertyValue, Query, QueryResult, QuerySource } from '@savoire/plugin-api'
import {
  LightRows, ManifestStore, createPageRow, folderOfBase, readManifest, resolveBase, toWhere, writeNoteProperty,
} from '@savoire/plugin-base'
import { FRAME_BOOT, FRAME_READY, MAX_MESSAGE, boardFrameUrl, buildSrcdoc, randomChannel } from './frame'

/** Ecritures au plus, par minute et par board. */
export const MAX_WRITES_PER_MINUTE = 60
/** Requetes suivies au plus, par board. */
export const MAX_WATCHES = 50

export interface BoardHostOptions {
  /** Chemin du board (cle de l'accord d'ecriture). */
  boardPath: string
  readOnly: boolean
  /** Hauteur du contenu (integration : l'iframe suit). */
  onSize?: (height: number) => void
  /** Erreur du code du board, ou d'un appel refuse. */
  onError?: (message: string) => void
  /**
   * Demande l'accord pour ecrire (premiere ecriture du board). Rend true si
   * la personne accepte.
   */
  confirmWrite?: (what: string) => Promise<boolean>
}

/** Accords donnes pendant la session, par board : on ne redemande pas. */
const grants = new Map<string, boolean>()

/** Oublie les accords (tests). */
export function resetBoardGrants(): void {
  grants.clear()
}

/** Une ligne d'un resultat (savoire.query), un chemin de note, ou { base, id } pour une ligne legere. */
type Target = string | { path?: string; id?: string; base?: string }

/** Lignes legeres retenues (id -> base) : une ligne d'un resultat s'ecrit sans dire sa base. */
const MAX_KNOWN_ROWS = 100_000

const isPlainValue = (v: unknown): v is PropertyValue =>
  v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))
  || (Array.isArray(v) && v.length <= 200 && v.every(x => typeof x === 'string'))

export class BoardHost {
  readonly frame: HTMLIFrameElement
  private readonly channel = randomChannel()
  private readonly watches = new Map<number, () => void>()
  private readonly onMessage = (e: MessageEvent) => this.handle(e)
  private writes: number[] = []
  private disposed = false
  /** Document a envoyer a la page cadre quand elle sera prete (version bureau). */
  private pendingHtml: string | null = null
  private loads = 0
  /** Base de chaque ligne legere vue dans un resultat. */
  private readonly rowBase = new Map<string, string>()
  /** Lots ouverts pour ecrire, par base. */
  private readonly lightRows = new Map<string, Promise<{ tree: ISharedTree | undefined; rows: LightRows }>>()

  constructor(private readonly api: PluginAPI | undefined, private readonly opts: BoardHostOptions) {
    const frame = document.createElement('iframe')
    frame.setAttribute('sandbox', 'allow-scripts')
    frame.setAttribute('referrerpolicy', 'no-referrer')
    frame.setAttribute('title', opts.boardPath)
    frame.dataset.testid = 'board-frame'
    this.frame = frame
    window.addEventListener('message', this.onMessage)
  }

  /** (Re)charge le code du board : les requetes suivies de l'ancien s'arretent. */
  load(source: string): void {
    this.stopWatches()
    const html = buildSrcdoc(source, { channel: this.channel, readOnly: this.opts.readOnly })
    const url = boardFrameUrl()
    if (!url) { this.frame.srcdoc = html; return }
    // Page cadre (bureau) : on la recharge, elle dit qu'elle est prete, puis
    // recoit le document.
    this.pendingHtml = html
    this.frame.src = `${url}${url.includes('?') ? '&' : '?'}n=${++this.loads}`
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    window.removeEventListener('message', this.onMessage)
    this.stopWatches()
    this.pendingHtml = null
    if (boardFrameUrl()) this.frame.removeAttribute('src')
    else this.frame.srcdoc = ''
    for (const [baseId, p] of this.lightRows) {
      void p.then(({ tree, rows }) => { rows.close(); if (tree) this.api?.vault.closeTree?.(baseId) }, () => {})
    }
    this.lightRows.clear()
  }

  /** Retient la base des lignes legeres d'un resultat. */
  private remember(q: Query, r: QueryResult): QueryResult {
    const from = q.from as { base?: string } | undefined
    if (from && typeof from.base === 'string') {
      for (const row of r.rows) {
        if (row.path !== '') continue
        if (this.rowBase.size >= MAX_KNOWN_ROWS) this.rowBase.clear()
        this.rowBase.set(row.id, from.base)
      }
    }
    return plain(r)
  }

  private stopWatches(): void {
    for (const stop of this.watches.values()) stop()
    this.watches.clear()
  }

  private post(msg: Record<string, unknown>): void {
    if (this.disposed) return
    // Origine opaque : '*' est la seule cible possible. Seule cette iframe le recoit.
    this.frame.contentWindow?.postMessage({ ch: this.channel, ...msg }, '*')
  }

  private handle(e: MessageEvent): void {
    if (this.disposed || e.source !== this.frame.contentWindow) return
    const m = e.data as { ch?: unknown; t?: unknown; id?: unknown; fn?: unknown; args?: unknown; q?: unknown; h?: unknown; m?: unknown } | null
    if (m && typeof m === 'object' && m.t === FRAME_READY) {
      const html = this.pendingHtml
      this.pendingHtml = null
      if (html !== null) this.frame.contentWindow?.postMessage({ t: FRAME_BOOT, html }, '*')
      return
    }
    if (!m || typeof m !== 'object' || m.ch !== this.channel) return
    let size = 0
    try { size = JSON.stringify(m).length } catch { return }
    if (size > MAX_MESSAGE) { this.opts.onError?.('Message du board trop gros.'); return }
    switch (m.t) {
      case 'size':
        if (typeof m.h === 'number' && Number.isFinite(m.h)) this.opts.onSize?.(Math.max(0, Math.min(20_000, m.h)))
        return
      case 'error':
        this.opts.onError?.(String(m.m ?? 'Erreur'))
        return
      case 'call': {
        const id = Number(m.id)
        void this.call(String(m.fn), Array.isArray(m.args) ? m.args : [])
          .then(v => this.post({ t: 'res', id, ok: true, v }))
          .catch(err => this.post({ t: 'res', id, ok: false, e: messageOf(err) }))
        return
      }
      case 'watch': {
        const id = Number(m.id)
        if (this.watches.size >= MAX_WATCHES) { this.post({ t: 'watch', id, ok: false, e: `Trop de requêtes suivies (${MAX_WATCHES} au plus).` }); return }
        void this.startWatch(id, m.q)
        return
      }
      case 'unwatch': {
        const id = Number(m.id)
        this.watches.get(id)?.()
        this.watches.delete(id)
        return
      }
    }
  }

  private async startWatch(id: number, raw: unknown): Promise<void> {
    const engine = this.api?.query
    try {
      if (!engine) throw new Error('Aucun moteur de requêtes : ouvrez un vault.')
      const q = await this.resolveQuery(raw)
      if (this.disposed) return
      const stop = engine.watch(q, r => this.post({ t: 'watch', id, ok: true, v: this.remember(q, r) }))
      if (this.disposed) { stop(); return }
      this.watches.set(id, stop)
    } catch (err) {
      this.post({ t: 'watch', id, ok: false, e: messageOf(err) })
    }
  }

  private async call(fn: string, args: unknown[]): Promise<unknown> {
    const api = this.api
    if (!api) throw new Error('Aucun vault ouvert.')
    switch (fn) {
      case 'query': {
        if (!api.query) throw new Error('Aucun moteur de requêtes : ouvrez un vault.')
        const q = await this.resolveQuery(args[0])
        return this.remember(q, await api.query.query(q))
      }
      case 'open': {
        const path = String(args[0] ?? '')
        if (!path || path.length > 1024) throw new Error('open : chemin attendu.')
        await api.workspace.openFile(path)
        return true
      }
      case 'setProperty':
        return this.setProperty(args[0] as Target, args[1], args[2])
      case 'createPage':
        return this.createPage(args[0], args[1], args[2])
      case 'createRow':
        return this.createRow(args[0], args[1], args[2])
      default:
        throw new Error(`Fonction inconnue : savoire.${fn}`)
    }
  }

  /** from: "Projets" ou { base: "Projets" } : la base, son dossier de pages, son filtre. */
  async resolveQuery(raw: unknown): Promise<Query> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Requête attendue : { from, where, sort, ... }')
    const q = { ...(raw as Record<string, unknown>) } as Record<string, unknown>
    const from = q.from
    if (typeof from === 'string' || (from && typeof from === 'object' && 'base' in from && typeof (from as { base: unknown }).base === 'string' && !(from as { pages?: unknown }).pages)) {
      q.from = await this.baseSource(typeof from === 'string' ? from : (from as { base: string }).base)
    }
    return q as unknown as Query
  }

  private async baseSource(name: string): Promise<QuerySource> {
    const api = this.api!
    const base = await resolveBase(api, name)
    if (!base) throw new Error(`Base introuvable : « ${name} »`)
    let folder = folderOfBase(base.path)
    let where
    const tree = await api.vault.openTree?.(base.id).catch(() => undefined)
    if (tree) {
      const manifest = readManifest(tree, folder)
      folder = manifest.source.folder
      where = toWhere(manifest.source.filters)
      api.vault.closeTree?.(base.id)
    }
    return { base: base.id, pages: { folder: folder.replace(/\/+$/, '') || undefined, ext: ['md'], ...(where ? { where } : {}) } }
  }

  /** Accord et debit avant une ecriture. */
  private async allowWrite(what: string): Promise<void> {
    if (this.opts.readOnly) throw new Error('Lecture seule : ce board ne peut rien modifier ici.')
    const now = Date.now()
    this.writes = this.writes.filter(t => now - t < 60_000)
    if (this.writes.length >= MAX_WRITES_PER_MINUTE) throw new Error(`Trop d'écritures (${MAX_WRITES_PER_MINUTE} par minute au plus).`)
    let granted = grants.get(this.opts.boardPath)
    if (granted === undefined) {
      granted = this.opts.confirmWrite ? await this.opts.confirmWrite(what) : false
      grants.set(this.opts.boardPath, granted)
    }
    if (!granted) throw new Error('Écriture refusée pour ce board.')
    this.writes.push(now)
  }

  private async setProperty(target: Target, key: unknown, value: unknown): Promise<boolean> {
    const vault = this.api!.vault
    if (typeof key !== 'string' || !key.trim() || key.length > 200 || /[\n:]/.test(key)) throw new Error('setProperty : nom de propriété invalide.')
    if (value !== undefined && !isPlainValue(value)) throw new Error('setProperty : valeur simple attendue (texte, nombre, case, liste de textes).')
    // Ligne legere : sa base est connue (vue dans un resultat) ou donnee.
    if (typeof target === 'object' && target && !target.path && typeof target.id === 'string' && target.id) {
      const rowId = target.id
      const baseId = typeof target.base === 'string' && target.base
        ? (await resolveBase(this.api!, target.base))?.id
        : this.rowBase.get(rowId)
      if (!baseId) throw new Error('setProperty : ligne légère inconnue. Passez { base: "NomDeLaBase", id } ou une ligne lue par savoire.query.')
      await this.allowWrite(`ligne ${rowId} : ${key} = ${JSON.stringify(value ?? null)}`)
      const { rows } = await this.lightRowsOf(baseId)
      await rows.setCell(rowId, key, (value ?? null) as PropertyValue)
      return true
    }
    const path = typeof target === 'string' ? target : target?.path
    const id = path ? vault.resolveDocumentId(path) : undefined
    if (!path || !/\.md$/i.test(path) || !id) throw new Error(`setProperty : note introuvable (${path ?? '?'})`)
    await this.allowWrite(`${path} : ${key} = ${JSON.stringify(value ?? null)}`)
    await writeNoteProperty(vault, id, key, value as PropertyValue | undefined)
    return true
  }

  private async createPage(baseName: unknown, title: unknown, values: unknown): Promise<{ path: string; id: string }> {
    const vault = this.api!.vault
    if (typeof baseName !== 'string' || !baseName) throw new Error('createPage : nom de base attendu.')
    const name = typeof title === 'string' && title.trim() ? title.trim().slice(0, 200) : 'Sans titre'
    const vals = plainValues(values, 'createPage')
    const source = await this.baseSource(baseName)
    const folder = 'base' in source ? source.pages?.folder ?? '' : ''
    await this.allowWrite(`nouvelle page « ${name} » dans ${baseName}`)
    return createPageRow(vault, folder, name, vals)
  }

  /** Nouvelle ligne legere ; rend son id. */
  private async createRow(baseName: unknown, title: unknown, values: unknown): Promise<{ id: string }> {
    if (typeof baseName !== 'string' || !baseName) throw new Error('createRow : nom de base attendu.')
    const name = typeof title === 'string' && title.trim() ? title.trim().slice(0, 200) : 'Sans titre'
    const vals = plainValues(values, 'createRow')
    const base = await resolveBase(this.api!, baseName)
    if (!base) throw new Error(`Base introuvable : « ${baseName} »`)
    await this.allowWrite(`nouvelle ligne « ${name} » dans ${baseName}`)
    const { rows } = await this.lightRowsOf(base.id)
    const id = await rows.add(name, vals)
    this.rowBase.set(id, base.id)
    return { id }
  }

  /** Les lots d'une base, ouverts pour ecrire (manifeste et arbres annexes). */
  private lightRowsOf(baseId: string): Promise<{ tree: ISharedTree | undefined; rows: LightRows }> {
    let p = this.lightRows.get(baseId)
    if (!p) {
      const vault = this.api!.vault
      p = (async () => {
        if (!vault.sharedData || !vault.openTree) throw new Error('Lignes légères indisponibles sans synchronisation du vault.')
        const tree = await vault.openTree(baseId)
        const shared = vault.sharedData(baseId)
        const store = new ManifestStore(tree, () => readManifest(tree, ''))
        return { tree, rows: new LightRows(shared, store, () => readManifest(tree, '').lotCount) }
      })()
      p.catch(() => this.lightRows.delete(baseId))
      this.lightRows.set(baseId, p)
    }
    return p
  }
}

/** Valeurs simples d'une nouvelle ligne (100 au plus). */
function plainValues(values: unknown, fn: string): Record<string, PropertyValue> {
  const vals: Record<string, PropertyValue> = {}
  if (values && typeof values === 'object' && !Array.isArray(values)) {
    for (const [k, v] of Object.entries(values as Record<string, unknown>).slice(0, 100)) {
      if (!k || k.length > 200 || /[\n:]/.test(k)) continue
      if (!isPlainValue(v)) throw new Error(`${fn} : valeur simple attendue pour « ${k} ».`)
      vals[k] = v
    }
  }
  return vals
}

function messageOf(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message)
  return String(err)
}

/** Le resultat, en donnees simples (passe par postMessage). */
function plain(r: QueryResult): QueryResult {
  return JSON.parse(JSON.stringify(r)) as QueryResult
}
