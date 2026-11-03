// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Cote Savoire d'un board : l'iframe isolee (frame.ts) et les seules choses
// qu'elle peut demander.
//
//   savoire.query(q)            requete declarative (IQueryEngine), une fois
//   savoire.watch(q, cb)        la meme, suivie en direct ; rend l'arret
//   savoire.open(path)          ouvre une note
//   savoire.setProperty(t, k, v) ecrit une propriete d'une note (ligne-page)
//   savoire.createPage(base, title, values)  nouvelle ligne-page d'une base
//
// Dans une requete, `from` peut nommer une base comme dans un bloc
// ```base : { base: "Projets" } (nom, chemin ou id), ou simplement "Projets".
// Savoire la resout et ajoute son dossier de pages et son filtre de source.
//
// Ecritures : jamais en lecture seule ; la premiere de chaque board demande
// l'accord de la personne qui le regarde (le code est celui d'un autre
// membre) ; debit borne.
import type { PluginAPI, PropertyValue, Query, QueryResult, QuerySource } from '@savoire/plugin-api'
import { createPageRow, folderOfBase, readManifest, resolveBase, toWhere, writeNoteProperty } from '@savoire/plugin-base'
import { MAX_MESSAGE, buildSrcdoc, randomChannel } from './frame'

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

type Target = string | { path?: string; id?: string }

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
    this.frame.srcdoc = buildSrcdoc(source, { channel: this.channel, readOnly: this.opts.readOnly })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    window.removeEventListener('message', this.onMessage)
    this.stopWatches()
    this.frame.srcdoc = ''
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
      const stop = engine.watch(q, r => this.post({ t: 'watch', id, ok: true, v: plain(r) }))
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
        return plain(await api.query.query(await this.resolveQuery(args[0])))
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
    // Une ligne d'un resultat (savoire.query) ou un chemin de note.
    if (typeof target === 'object' && target && !target.path && target.id) {
      throw new Error('setProperty : ligne légère d\'une base, modifiable dans la base seulement pour l\'instant.')
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
    const vals: Record<string, PropertyValue> = {}
    if (values && typeof values === 'object' && !Array.isArray(values)) {
      for (const [k, v] of Object.entries(values as Record<string, unknown>).slice(0, 100)) {
        if (!k || k.length > 200 || /[\n:]/.test(k)) continue
        if (!isPlainValue(v)) throw new Error(`createPage : valeur simple attendue pour « ${k} ».`)
        vals[k] = v
      }
    }
    const source = await this.baseSource(baseName)
    const folder = 'base' in source ? source.pages?.folder ?? '' : ''
    await this.allowWrite(`nouvelle page « ${name} » dans ${baseName}`)
    return createPageRow(vault, folder, name, vals)
  }
}

function messageOf(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message)
  return String(err)
}

/** Le resultat, en donnees simples (passe par postMessage). */
function plain(r: QueryResult): QueryResult {
  return JSON.parse(JSON.stringify(r)) as QueryResult
}
