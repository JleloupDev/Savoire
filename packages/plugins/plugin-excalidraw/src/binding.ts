// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Liaison entre une scene Excalidraw et l'arbre partage du document
// (ctx.tree). Aucun import d'Excalidraw ici : la vue fournit l'etat courant
// et applique ce qu'on lui rend. Testable sans DOM.
//
// Rangement : des cles plates dans la racine de l'arbre.
//   el:<id>    -> chaine JSON de l'element entier ;
//   z:<id>     -> nombre, rang de l'element dans la pile (ordre d'affichage) ;
//   file:<id>  -> chaine JSON d'une image collee (chemin de piece jointe).
//
// Pourquoi des cles plates : aucune structure a creer. Deux membres qui
// dessinent en meme temps sur un document neuf ne se disputent pas une carte
// « elements » posee deux fois (le dernier gagnant effacerait l'autre).
//
// Pourquoi un element = une chaine JSON, pas une carte de proprietes :
// Excalidraw raisonne element par element (version, versionNonce). Fusionner
// propriete par propriete donnerait des elements hybrides incoherents (les
// points d'une fleche de l'un, sa largeur de l'autre ; le texte de l'un, sa
// taille de l'autre). Le rang est a part pour qu'un « mettre au premier plan »
// n'ecrase pas un deplacement fait en meme temps.
//
// Regle de fusion, celle d'Excalidraw : la version la plus haute gagne ; a
// version egale, le plus petit versionNonce. L'arbre, lui, garde un seul
// gagnant par cle, pas forcement le meme : quand une vue tient un element
// meilleur que celui de l'arbre, elle le reecrit. Tous les membres
// convergent vers le meilleur element au sens d'Excalidraw.
import type { ISharedTree, TreeChange, TreeChangeInfo } from '@savoire/plugin-api'

export interface SceneElement {
  id: string
  version: number
  versionNonce: number
  isDeleted?: boolean
  [key: string]: unknown
}

export interface SceneFile {
  id: string
  mimeType: string
  dataURL: string
  created?: number
  [key: string]: unknown
}

/** Image telle que rangee dans l'arbre : une piece jointe, ou a defaut les octets. */
export interface StoredFile {
  mimeType: string
  created?: number
  /** Chemin de la piece jointe dans le vault. */
  path?: string
  /** Contenu en data URL, seulement si le vault ne sait pas stocker de piece jointe. */
  dataURL?: string
}

export interface SceneBindingOptions {
  tree: ISharedTree
  /** Elements de la vue, supprimes compris. null : vue pas encore prete. */
  getElements(): readonly SceneElement[] | null
  /** Elements pris dans un geste local (deplacement, saisie) : jamais remplaces. */
  getBusyIds?(): ReadonlySet<string>
  /** Pose la scene reconciliee dans la vue. */
  applyElements(elements: SceneElement[]): void
  hasFile(id: string): boolean
  addFiles(files: SceneFile[]): void
  /** Range une image (piece jointe). Absent : l'image va dans l'arbre en data URL. */
  storeFile?(file: SceneFile): Promise<StoredFile>
  /** Relit une image rangee en piece jointe. */
  loadFile?(id: string, stored: StoredFile): Promise<SceneFile | null>
  /** Delai d'ecriture groupee (ms). Defaut 80. */
  throttleMs?: number
  /** Une modification venue d'ailleurs a ete appliquee. */
  onRemoteApplied?(): void
}

const EL = 'el:'
const Z = 'z:'
const FILE = 'file:'

/** Vrai si `a` l'emporte sur `b` (regle d'Excalidraw). */
export function isBetter(a: Pick<SceneElement, 'version' | 'versionNonce'>, b: Pick<SceneElement, 'version' | 'versionNonce'>): boolean {
  return a.version > b.version || (a.version === b.version && a.versionNonce < b.versionNonce)
}

/**
 * Rangs a (re)donner pour que `ids` soit dans l'ordre croissant des rangs.
 * On garde la plus longue suite deja croissante ; les autres recoivent un
 * rang entre leurs voisins. Rend seulement les rangs qui changent.
 */
export function assignOrder(ids: readonly string[], zOf: ReadonlyMap<string, number>): Map<string, number> {
  const n = ids.length
  const zs = ids.map(id => zOf.get(id))
  // Plus longue sous-suite strictement croissante (tri par paquets).
  const tails: number[] = []
  const prev = new Array<number>(n).fill(-1)
  for (let i = 0; i < n; i++) {
    const z = zs[i]
    if (z === undefined) continue
    let lo = 0, hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if ((zs[tails[mid]] as number) < z) lo = mid + 1
      else hi = mid
    }
    if (lo > 0) prev[i] = tails[lo - 1]
    tails[lo] = i
  }
  const keep = new Set<number>()
  for (let i = tails.length ? tails[tails.length - 1] : -1; i !== -1; i = prev[i]) keep.add(i)

  const out = new Map<string, number>()
  let i = 0
  while (i < n) {
    if (keep.has(i)) { i++; continue }
    let j = i
    while (j < n && !keep.has(j)) j++
    const lo = i > 0 ? zs[i - 1] as number : undefined
    const hi = j < n ? zs[j] as number : undefined
    const k = j - i
    for (let m = 0; m < k; m++) {
      let z: number
      if (lo === undefined && hi === undefined) z = m + 1
      else if (lo === undefined) z = (hi as number) - (k - m)
      else if (hi === undefined) z = lo + m + 1
      else {
        const step = (hi - lo) / (k + 1)
        // Plus de place entre deux rangs : on renumerote tout.
        if (!(step > Math.max(1, Math.abs(lo)) * 1e-9)) return renumber(ids, zOf)
        z = lo + step * (m + 1)
      }
      zs[i + m] = z
      out.set(ids[i + m], z)
    }
    i = j
  }
  return out
}

function renumber(ids: readonly string[], zOf: ReadonlyMap<string, number>): Map<string, number> {
  const out = new Map<string, number>()
  ids.forEach((id, i) => { if (zOf.get(id) !== i + 1) out.set(id, i + 1) })
  return out
}

export class SceneBinding {
  /** Etiquette de nos transactions : propre a cette vue (anti-echo). */
  private readonly tag = Symbol('plugin-excalidraw')
  /** Version et nonce de chaque element tel qu'il est dans l'arbre. */
  private readonly known = new Map<string, { version: number; versionNonce: number }>()
  /** Rang de chaque element vu par cette vue (ecrit ou en attente). */
  private readonly zOf = new Map<string, number>()
  /** Rangs changes localement, pas encore ecrits. */
  private readonly dirtyZ = new Set<string>()
  /** Images deja dans l'arbre, ou en cours d'envoi. */
  private readonly knownFiles = new Set<string>()
  private readonly sending = new Set<string>()
  private readonly loading = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private unsub: (() => void) | null = null
  private writable = true
  private destroyed = false

  constructor(private readonly opts: SceneBindingOptions) {}

  /** Lit l'etat deja connu de l'arbre et s'abonne a ses changements. */
  start(): void {
    const root = this.opts.tree.root
    for (const key of root.keys()) this.readKey(key)
    this.unsub = this.opts.tree.onChange((changes, info) => this.onTreeChange(changes, info))
  }

  /** Elements de l'arbre, dans l'ordre d'affichage. */
  readElements(): SceneElement[] {
    const root = this.opts.tree.root
    const out: SceneElement[] = []
    for (const key of root.keys()) {
      if (!key.startsWith(EL)) continue
      const el = parseElement(root.get(key))
      if (el) out.push(el)
    }
    return this.sortByZ(out)
  }

  /** Vrai si l'arbre ne contient encore aucun element. */
  isEmpty(): boolean {
    return !this.opts.tree.root.keys().some(k => k.startsWith(EL))
  }

  /** Remplace la scene de la vue par celle de l'arbre, et charge ses images. */
  resetFromTree(): void {
    this.opts.applyElements(this.readElements())
    for (const key of this.opts.tree.root.keys()) {
      if (key.startsWith(FILE)) this.readFile(key.slice(FILE.length))
    }
  }

  /** En lecture seule, on n'ecrit rien (pas meme les reecritures de fusion). */
  setWritable(writable: boolean): void {
    this.writable = writable
    if (writable) this.schedule()
  }

  /** La vue a change (onChange d'Excalidraw). Ecriture groupee. */
  localChange(files?: Readonly<Record<string, SceneFile>>): void {
    if (this.destroyed || !this.writable) return
    if (files) this.sendFiles(files)
    this.schedule()
  }

  /** Ecrit tout de suite ce qui differe de l'arbre. */
  flush(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null }
    if (this.destroyed || !this.writable) return
    const elements = this.opts.getElements()
    if (!elements) return
    this.updateOrder(elements)
    const changed = elements.filter(el => {
      const k = this.known.get(el.id)
      return !k || k.version !== el.version || k.versionNonce !== el.versionNonce
    })
    if (changed.length === 0 && this.dirtyZ.size === 0) return
    const root = this.opts.tree.root
    const dirty = [...this.dirtyZ]
    this.dirtyZ.clear()
    this.opts.tree.transact(() => {
      for (const el of changed) {
        root.set(EL + el.id, JSON.stringify(el))
        this.known.set(el.id, { version: el.version, versionNonce: el.versionNonce })
      }
      for (const id of dirty) {
        const z = this.zOf.get(id)
        if (z !== undefined) root.set(Z + id, z)
      }
    }, this.tag)
  }

  destroy(): void {
    if (this.timer !== null) this.flush()
    this.destroyed = true
    this.unsub?.()
    this.unsub = null
  }

  // ── Interne ──────────────────────────────────────────────────────────

  private schedule(): void {
    if (this.timer !== null || this.destroyed) return
    this.timer = setTimeout(() => { this.timer = null; this.flush() }, this.opts.throttleMs ?? 80)
  }

  /** Rangs locaux : l'ordre de la vue fait foi pour ce qu'on n'a pas encore ecrit. */
  private updateOrder(elements: readonly SceneElement[]): void {
    const changed = assignOrder(elements.map(e => e.id), this.zOf)
    for (const [id, z] of changed) {
      this.zOf.set(id, z)
      this.dirtyZ.add(id)
    }
  }

  private sortByZ(elements: SceneElement[]): SceneElement[] {
    const rank = (e: SceneElement) => this.zOf.get(e.id) ?? Number.POSITIVE_INFINITY
    return elements
      .map((e, i) => ({ e, i }))
      .sort((a, b) => rank(a.e) - rank(b.e) || (a.e.id < b.e.id ? -1 : a.e.id > b.e.id ? 1 : a.i - b.i))
      .map(x => x.e)
  }

  /** Lit une cle de l'arbre ; rend l'element distant s'il y en a un. */
  private readKey(key: string): SceneElement | null {
    const root = this.opts.tree.root
    if (key.startsWith(EL)) {
      const el = parseElement(root.get(key))
      if (el) this.known.set(el.id, { version: el.version, versionNonce: el.versionNonce })
      return el
    }
    if (key.startsWith(Z)) {
      const id = key.slice(Z.length)
      const z = root.get(key)
      if (typeof z === 'number' && !this.dirtyZ.has(id)) this.zOf.set(id, z)
      return null
    }
    if (key.startsWith(FILE)) this.knownFiles.add(key.slice(FILE.length))
    return null
  }

  private onTreeChange(changes: TreeChange[], info: TreeChangeInfo): void {
    if (info.tag === this.tag || this.destroyed) return
    const root = this.opts.tree.root
    const keys = new Set<string>()
    for (const c of changes) {
      if (c.kind === 'map' && c.target === root) for (const k of c.keys) keys.add(k)
    }
    if (keys.size === 0) return

    const local = this.opts.getElements()
    // L'ordre local en attente d'ecriture prime sur les rangs qui arrivent.
    if (local && this.writable) this.updateOrder(local)

    const remote = new Map<string, SceneElement>()
    let orderChanged = false
    for (const key of keys) {
      const el = this.readKey(key)
      if (el) remote.set(el.id, el)
      if (key.startsWith(Z)) orderChanged = true
      if (key.startsWith(FILE)) this.readFile(key.slice(FILE.length))
    }
    if (!local) return
    if (remote.size === 0 && !orderChanged) return

    const busy = this.opts.getBusyIds?.() ?? new Set<string>()
    let keptLocal = false
    const seen = new Set<string>()
    const next: SceneElement[] = []
    for (const l of local) {
      seen.add(l.id)
      const r = remote.get(l.id)
      if (!r) { next.push(l); continue }
      if (busy.has(l.id) || isBetter(l, r)) { next.push(l); keptLocal = true }
      else next.push(r)
    }
    for (const r of remote.values()) if (!seen.has(r.id)) next.push(r)
    this.opts.applyElements(this.sortByZ(next))
    this.opts.onRemoteApplied?.()
    // Notre element vaut mieux que celui de l'arbre : on le reecrit.
    if (keptLocal) this.schedule()
  }

  private sendFiles(files: Readonly<Record<string, SceneFile>>): void {
    for (const file of Object.values(files)) {
      if (this.knownFiles.has(file.id) || this.sending.has(file.id)) continue
      this.sending.add(file.id)
      const store = this.opts.storeFile
        ? this.opts.storeFile(file)
        : Promise.resolve<StoredFile>({ mimeType: file.mimeType, created: file.created, dataURL: file.dataURL })
      store.then(stored => {
        this.sending.delete(file.id)
        if (this.destroyed || this.knownFiles.has(file.id)) return
        this.knownFiles.add(file.id)
        this.opts.tree.transact(() => { this.opts.tree.root.set(FILE + file.id, JSON.stringify(stored)) }, this.tag)
      }, err => {
        this.sending.delete(file.id)
        console.warn('[plugin-excalidraw] image non enregistree', file.id, err)
      })
    }
  }

  private readFile(id: string): void {
    this.knownFiles.add(id)
    if (this.opts.hasFile(id) || this.loading.has(id)) return
    const stored = parseStoredFile(this.opts.tree.root.get(FILE + id))
    if (!stored) return
    if (stored.dataURL) {
      this.opts.addFiles([{ id, mimeType: stored.mimeType, dataURL: stored.dataURL, created: stored.created }])
      return
    }
    if (!this.opts.loadFile) return
    this.loading.add(id)
    this.opts.loadFile(id, stored).then(file => {
      this.loading.delete(id)
      if (file && !this.destroyed) this.opts.addFiles([file])
    }, err => {
      this.loading.delete(id)
      console.warn('[plugin-excalidraw] image illisible', id, err)
    })
  }
}

function parseElement(v: unknown): SceneElement | null {
  if (typeof v !== 'string') return null
  try {
    const el = JSON.parse(v) as SceneElement
    return el && typeof el.id === 'string' && typeof el.version === 'number' ? el : null
  } catch {
    return null
  }
}

function parseStoredFile(v: unknown): StoredFile | null {
  if (typeof v !== 'string') return null
  try {
    const f = JSON.parse(v) as StoredFile
    return f && typeof f.mimeType === 'string' ? f : null
  } catch {
    return null
  }
}
