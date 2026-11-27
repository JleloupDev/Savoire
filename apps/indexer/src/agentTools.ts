// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Pouvoir « tools » : les outils des agents, executes par le pair pour les IA
// externes (ChatGPT, Claude), ADR-033.
//
//   tools.list  {}                         -> { tools: ToolSpec[] }   (catalogue du socle)
//   tools.call  { name, args, mode, agent, actor, ticket, access, typing? }
//               -> { text, isError, sources? }
//
// `typing` : ou la personne tape en ce moment ({ docId, blockHash, anchor,
// ageMs }), d'apres le contexte de l'editeur que le serveur garde. Un outil
// n'ecrit pas dans ce paragraphe (agent-core/typingGuard.ts).
//
// Seul le serveur appelle ce pouvoir (la route publique le refuse). Il a deja
// verifie l'agent, le vault et le mode ; il joint un TICKET d'ecriture et les
// regles d'acces de la personne. Les outils sont ceux de @savoire/agent-core,
// au-dessus d'un hote qui lit les journaux Yjs et renvoie au serveur ce qu'il
// ecrit (POST /internal/indexer/vaults/{id}/write). Le serveur reverifie tout.
import {
  HostError, ToolBox, agentColor, coreCatalog, minimalChange, parseTypingSpot, planTyping, titleOf,
  type AgentToolHost, type HostFilePages, type HostHit, type HostNote, type HostNoteRef, type HostRequest, type HostReviewEntry, type RequestState, type TextChange, type TypingSpot,
} from '@savoire/agent-core'
import {
  NOTE_TEXT, editDoc, vaultTreeFromUpdates, mapEntries, mapEntryUpdate, newNoteUpdate, noteText, parentFolders, replaceTextUpdate, resolveRelativeRange, textAnchor, treeFoldersUpdate, treeSetUpdate,
} from '@savoire/indexer-core'
import { AiChangeTracker, recordAiChange } from '@savoire/infrastructure-sync/ai-changes'
import { MAX_PROPOSAL_BYTES, relinkAfterMoves, textFingerprint, type AgentDefinition, type RelinkVault, type ToolActor } from '@savoire/plugin-api'
import { baseOfQuery, canRead, filterResult, parseAccess, type AccessRules } from './access'
import type { PresenceBody, UpdatesLog, WriteBody } from './backend'
import { HttpError } from './errors'
import type { ServerPluginSet } from './serverPlugins'

export const TOOLS_CAPABILITY = 'tools'
const REVIEW_NS = 'map/review'
const TYPES_NS = 'settings/properties'
/** Operations au plus dans une ecriture (MAX_WRITE_OPS du serveur). */
const MAX_WRITE_OPS = 32
const TRASH_DIR = '.trash/'
const MAX_READ = 512 * 1024
/**
 * Effet de frappe : un long texte part en quelques ecritures, sur 1,5 s au
 * plus. Un appel d'outil doit finir bien avant le delai du pair (4 s par defaut).
 */
export const TYPING = { budgetMs: 1500, maxWrites: 12, maxDelayMs: 140 }
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Ce que le magasin du vault donne a l'hote (store.ts). */
export interface PeerVaultFacade {
  /** id -> chemin, corbeille comprise. */
  paths(): Promise<Map<string, string>>
  /** Texte d'un document (note, fichier extrait, texte publie). */
  readText(id: string, path: string): Promise<string | null>
  /** Quelques pages d'un fichier pagine (PDF), lues par morceaux. Null : pas un tel fichier. Absent : non. */
  readPages?(id: string, path: string, from: number, to: number): Promise<{ total: number; from: number; to: number; pages: { page: number; text: string }[] } | null>
  /** Un pouvoir de l'index (search, query, links, tags). */
  call(capability: string, method: string, params: Record<string, unknown>): Promise<unknown>
  docLog(id: string): Promise<UpdatesLog | null | undefined>
  treeLog(): Promise<UpdatesLog | null>
  reviewLog(): Promise<UpdatesLog | null>
  /** Journal des types des proprietes du vault (canal « settings/properties »). */
  typesLog(): Promise<UpdatesLog | null>
  write(body: WriteBody): Promise<void>
  /** Ce que l'agent fait dans une note, montre a qui l'a ouverte. Absent : pas de presence. Ne rejette pas. */
  presence?(body: PresenceBody): Promise<void>
}

type PresenceSignal = Parameters<NonNullable<AgentToolHost['signal']>>[0]

const b64 = (u: Uint8Array): string => Buffer.from(u).toString('base64')
const isTrash = (p: string): boolean => p.startsWith(TRASH_DIR)

function uniquePath(path: string, taken: (p: string) => boolean): string {
  if (!taken(path)) return path
  const slash = path.lastIndexOf('/')
  const dot = path.lastIndexOf('.')
  const [base, ext] = dot > slash + 1 ? [path.slice(0, dot), path.slice(dot)] : [path, '']
  let n = 1
  while (taken(`${base} ${n}${ext}`)) n++
  return `${base} ${n}${ext}`
}

interface ReviewValue {
  id: string
  docId: string
  kind: HostReviewEntry['kind']
  text: string
  author: { kind: 'user'; userId?: string; displayName: string } | { kind: 'agent'; agentId?: string; agentName: string; onBehalfOf: { displayName: string } }
  createdAt: string
  parentId?: string
  status?: string
  anchor?: { quote: string }
  replacement?: string
  proposalType?: string
  payload?: unknown
  /** Demande adressee a un agent (ReviewService.ReviewRequest, agent-core/requests.ts). */
  request?: { agentId: string; agentName?: string; via?: string; state: RequestState; entryId?: string; askedAt?: string; doneAt?: string }
}

const describe = (a: ReviewValue['author']): string =>
  a?.kind === 'agent' ? `${a.agentName} (IA), pour ${a.onBehalfOf?.displayName ?? '?'}` : (a as { displayName?: string })?.displayName ?? '?'

export class PeerToolHost implements AgentToolHost {
  private pathCache: Map<string, string> | null = null

  constructor(
    private readonly f: PeerVaultFacade,
    private readonly access: AccessRules | undefined,
    private readonly ticket: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Ce que cet appel a deja cree ou deplace : l'index le saura un peu plus tard. */
  private readonly moved = new Map<string, string>()

  /** Trouves dans l'arborescence, pas encore dans l'index (crees juste avant, par un autre appel). */
  private readonly late = new Map<string, string>()

  /** Ou la personne tape en ce moment, d'apres le serveur ; posee par callTools. */
  typingSpot: TypingSpot | null = null

  async typing(docId: string): Promise<TypingSpot | null> {
    return this.typingSpot?.docId === docId ? this.typingSpot : null
  }

  private async paths(): Promise<Map<string, string>> {
    if (!this.pathCache) {
      const fetched = await this.f.paths()
      for (const [id, p] of this.late) fetched.set(id, p)
      for (const [id, p] of this.moved) fetched.set(id, p)
      this.pathCache = fetched
    }
    return this.pathCache
  }

  private treeCache: Map<string, string> | null = null

  /**
   * Les documents de l'arborescence du vault (id -> chemin), lue une fois par
   * appel. Elle est a jour quand l'index a du retard (une ou deux secondes
   * apres une creation) ; elle porte aussi les bases, dont l'index ne garde
   * que les lignes.
   */
  private async treeDocs(): Promise<Map<string, string>> {
    if (!this.treeCache) {
      const tree = await this.f.treeLog()
      this.treeCache = new Map(tree ? vaultTreeFromUpdates(tree.updates).docs : [])
      for (const [id, p] of this.moved) this.treeCache.set(id, p)
    }
    return this.treeCache
  }

  /** Le chemin d'un document : l'index, sinon l'arborescence. */
  private async pathOf(id: string): Promise<string | undefined> {
    return (await this.paths()).get(id) ?? this.remember(id, (await this.treeDocs()).get(id))
  }

  /** Un document que l'index ne connait pas encore : la suite de cet appel le trouve aussi. */
  private remember(id: string, path: string | undefined): string | undefined {
    if (path !== undefined) {
      this.late.set(id, path)
      this.pathCache?.set(id, path)
    }
    return path
  }

  private visible(id: string, path: string): boolean {
    return !isTrash(path) && canRead(this.access, id, path)
  }

  private async find(ref: { id?: string; path?: string }): Promise<HostNoteRef | undefined> {
    const hit = this.findIn(await this.paths(), ref)
    if (hit) return hit
    // Absent de l'index : peut-etre cree a l'instant (l'index suit avec un peu de retard).
    const late = this.findIn(await this.treeDocs(), ref)
    if (late) this.remember(late.id, late.path)
    return late
  }

  private findIn(paths: ReadonlyMap<string, string>, ref: { id?: string; path?: string }): HostNoteRef | undefined {
    if (ref.id) {
      const p = paths.get(ref.id)
      return p && this.visible(ref.id, p) ? { id: ref.id, path: p } : undefined
    }
    const wanted = ref.path ?? ''
    const fold = wanted.toLowerCase()
    let hit: HostNoteRef | undefined
    for (const [id, p] of paths) {
      if (!this.visible(id, p)) continue
      if (p === wanted) return { id, path: p }
      if (!hit && (p.toLowerCase() === fold || p.toLowerCase() === `${fold}.md`)) hit = { id, path: p }
    }
    return hit
  }

  private async noteLog(docId: string): Promise<UpdatesLog> {
    const log = await this.f.docLog(docId)
    if (!log || log.format !== 'yjs') throw new HostError('Cette note n’est pas un texte modifiable.', 'invalid')
    return log
  }

  private async write(body: Omit<WriteBody, 'ticket'>): Promise<void> {
    await this.f.write({ ticket: this.ticket, ...body })
    this.pathCache = null
    this.treeCache = null
  }

  // ── Presence (ADR-033) ───────────────────────────────────────────────────
  //
  // L'agent se montre dans la note qu'il lit ou ecrit, a qui l'a ouverte. Le
  // serveur retire la presence tout seul, peu apres la fin de l'appel. Rien
  // ici ne retarde l'outil ni ne le fait echouer : les signaux partent a la
  // suite, et un signal encore en attente est remplace par le suivant.

  /** Couleur de l'agent dans les notes ; posee par callTools. */
  presenceColor?: string
  private readonly waiting = new Map<string, PresenceSignal>()
  private sending: Promise<void> = Promise.resolve()

  signal(s: PresenceSignal): void {
    if (!this.f.presence) return
    const queued = this.waiting.has(s.docId)
    this.waiting.set(s.docId, s)
    if (queued) return
    this.sending = this.sending.then(async () => {
      const next = this.waiting.get(s.docId)
      this.waiting.delete(s.docId)
      if (next) await this.sendPresence(next)
    }).catch(() => undefined)
  }

  /** Les signaux en file sont partis (avant de rendre la main : apres, le ticket ne vaut plus rien). */
  presenceSettled(): Promise<void> {
    return this.sending
  }

  private async sendPresence(s: PresenceSignal): Promise<void> {
    const path = (await this.paths()).get(s.docId)
    if (!path || !this.visible(s.docId, path)) return
    let range: PresenceBody['range']
    if (s.state !== 'idle' && s.from !== undefined) {
      const log = await this.f.docLog(s.docId)
      if (log?.format === 'yjs') {
        // Positions relatives : elles suivent le texte si quelqu'un tape pendant ce temps.
        const a = textAnchor(log.updates, s.from, s.to ?? s.from)
        range = { anchor: a.from, head: a.to }
      }
    }
    await this.f.presence?.({
      ticket: this.ticket, docId: s.docId, state: s.state,
      ...(this.presenceColor ? { color: this.presenceColor } : {}), ...(range ? { range } : {}),
    })
  }

  // ── Lecture ──────────────────────────────────────────────────────────────

  async listNotes(p: { folder?: string; limit: number; cursor?: string }): Promise<{ items: HostNoteRef[]; total: number; next?: string }> {
    const prefix = p.folder ? `${p.folder.replace(/\/+$/, '')}/` : ''
    const all = [...await this.paths()].filter(([id, path]) => path.startsWith(prefix) && this.visible(id, path))
      .map(([id, path]) => ({ id, path })).sort((a, b) => a.path.localeCompare(b.path))
    const start = Math.max(0, Number(p.cursor ?? 0) || 0)
    return { items: all.slice(start, start + p.limit), total: all.length, ...(start + p.limit < all.length ? { next: String(start + p.limit) } : {}) }
  }

  async search(p: { text: string; limit: number; folder?: string }): Promise<HostHit[]> {
    const r = await this.f.call('search', 'run', { text: p.text, limit: p.limit, ...(p.folder ? { folder: p.folder } : {}) }) as { hits?: { id: string; path: string; title?: string; snippets?: { text: string }[] }[] }
    return (r.hits ?? []).filter(h => this.visible(h.id, h.path)).map(h => ({ id: h.id, path: h.path, ...(h.title ? { title: h.title } : {}), snippets: (h.snippets ?? []).map(s => s.text) }))
  }

  async findNote(ref: { id?: string; path?: string }): Promise<HostNoteRef | null> {
    return (await this.find(ref)) ?? null
  }

  async readNote(ref: { id?: string; path?: string }): Promise<HostNote | null> {
    const n = await this.find(ref)
    if (!n) return null
    const content = await this.f.readText(n.id, n.path)
    if (content === null) return null
    const truncated = content.length > MAX_READ
    return { ...n, title: titleOf(n.path), content: truncated ? content.slice(0, MAX_READ) : content, ...(truncated ? { truncated } : {}) }
  }

  async readFilePages(ref: { id?: string; path?: string }, from: number, to: number): Promise<HostFilePages | null> {
    if (!this.f.readPages) return null
    const n = await this.find(ref)
    if (!n) return null
    const r = await this.f.readPages(n.id, n.path, from, to)
    return r ? { ...n, ...r } : null
  }

  async power(capability: string, method: string, params: Record<string, unknown>): Promise<unknown | null> {
    if (!['links', 'tags', 'blocks', 'query'].includes(capability)) return null
    const result = await this.f.call(capability, method, params)
    // Les memes regles d'acces que les appels directs (lignes legeres : celles de leur base).
    const baseId = capability === 'query' ? baseOfQuery(params) : undefined
    let basePath = baseId ? (await this.paths()).get(baseId) : undefined
    if (baseId && !basePath) {
      const tree = await this.f.treeLog()
      basePath = tree ? vaultTreeFromUpdates(tree.updates).docs.get(baseId) : undefined
    }
    return filterResult(this.access, capability, method, result, baseId && basePath ? { base: { id: baseId, path: basePath } } : {})
  }

  private async reviewValues(): Promise<ReviewValue[]> {
    const log = await this.f.reviewLog()
    return log ? mapEntries(log.updates).map(e => e.value as ReviewValue).filter(v => !!v?.docId) : []
  }

  async listReview(docId: string): Promise<HostReviewEntry[]> {
    return (await this.reviewValues()).filter(e => e.docId === docId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(e => ({
      id: e.id, kind: e.kind, text: e.text, author: describe(e.author), authorIsAgent: e.author?.kind === 'agent', createdAt: e.createdAt,
      ...(e.status ? { status: e.status } : {}), ...(e.parentId ? { parentId: e.parentId } : {}),
      ...(e.anchor ? { quote: e.anchor.quote } : {}), ...(e.replacement !== undefined ? { replacement: e.replacement } : {}),
      ...(e.author?.kind === 'agent' && e.author.agentId ? { authorAgentId: e.author.agentId } : {}),
    }))
  }

  /** Ce qui porte la demande d'un fil : la racine, ou la reponse de la personne qui l'a relance. */
  private askOf(all: readonly ReviewValue[], root: ReviewValue): ReviewValue {
    const id = root.request?.entryId
    return (id ? all.find(x => x.id === id && x.parentId === root.id) : undefined) ?? root
  }

  /** La demande ouverte de ce fil est-elle adressee a cet agent, par la personne pour qui il agit ? */
  private asked(all: readonly ReviewValue[], root: ReviewValue, actor: ToolActor): boolean {
    const r = root.request
    if (root.parentId || root.kind !== 'comment' || !r || r.agentId !== actor.agentId || r.state !== 'open') return false
    const author = this.askOf(all, root).author
    return author?.kind === 'user' && author.userId === actor.onBehalfOf.userId
  }

  /** Les demandes ouvertes que la personne a adressees a cet agent, dans les notes qu'elle lit (requests.ts). */
  async listRequests(actor: ToolActor): Promise<HostRequest[]> {
    const all = await this.reviewValues()
    const paths = await this.paths()
    return all.flatMap(e => {
      const r = e.request
      if (!r || !this.asked(all, e, actor) || (e.status ?? 'open') !== 'open') return []
      const path = paths.get(e.docId)
      if (!path || !this.visible(e.docId, path)) return []
      const ask = this.askOf(all, e)
      return [{ id: e.id, docId: e.docId, path, text: ask.text, quote: e.anchor?.quote ?? '', author: describe(ask.author), createdAt: r.askedAt ?? ask.createdAt }]
    }).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /** L'agent a repondu : sa demande ouverte sur ce fil est close. */
  async closeRequest(rootId: string, actor: ToolActor): Promise<boolean> {
    const all = await this.reviewValues()
    let root = all.find(e => e.id === rootId)
    while (root?.parentId) root = all.find(e => e.id === root!.parentId)
    const r = root?.request
    if (!root || !r || !this.asked(all, root, actor)) return false
    const log = await this.f.reviewLog()
    const next = { ...root, request: { ...r, state: 'done', doneAt: this.now().toISOString() } }
    await this.write({ ops: [{ target: 'index', ns: REVIEW_NS, update: b64(mapEntryUpdate(log?.updates ?? [], root.id, next)) }] })
    return true
  }

  // ── Ecriture ─────────────────────────────────────────────────────────────

  async replaceText(docId: string, from: number, to: number, text: string): Promise<void> {
    const log = await this.noteLog(docId)
    if (to > noteText(log.updates).length) throw new HostError('La note a changé pendant la modification : relisez-la.', 'conflict')
    await this.write({ ops: [{ target: 'document', docId, update: b64(replaceTextUpdate(log.updates, from, to, text)) }] })
  }

  /**
   * Plusieurs remplacements en une ecriture. Avec `typing`, la suite d'un long
   * texte part morceau par morceau : autant d'ecritures, avec le meme ticket.
   * Le document rejoue reste ouvert le temps de l'appel ; chaque morceau est
   * la difference depuis le precedent.
   *
   * L'ecriture devient un point d'historique (modifications de l'IA,
   * infrastructure-sync/AiChanges.ts), annulable seul : qui, pour qui, quoi
   * (`what`) et pourquoi (`why`). Il part DANS la derniere mise a jour du
   * texte, jamais dans une ecriture de plus.
   */
  async applyChanges(docId: string, changes: readonly TextChange[], actor?: ToolActor, opts: { typing?: boolean; expect?: string; what?: string; why?: string } = {}): Promise<void> {
    if (!changes.length) return
    const log = await this.noteLog(docId)
    const edit = editDoc(log.updates)
    try {
      const text = edit.doc.getText(NOTE_TEXT)
      const before = text.toString()
      if (changes[changes.length - 1]!.to > before.length || (opts.expect !== undefined && textFingerprint(before) !== opts.expect)) {
        throw new HostError('La note a changé pendant la modification : relisez-la.', 'conflict')
      }
      const plan = opts.typing ? planTyping(changes, TYPING) : { first: changes, tails: [], delayMs: 0 }
      // Ce que l'agent change dans le texte, et rien d'autre : le document rejoue n'est qu'a lui.
      // (AiChanges decrit lui-meme ce qu'il attend de Yjs : les vrais types passent par un cast.)
      const tracker = new AiChangeTracker(text as never)
      // Le point rejoint les changements en attente : il part avec le prochain envoi.
      const point = (): void => {
        if (!actor) return
        recordAiChange(edit.doc as never, tracker.ops, {
          agent: { id: actor.agentId, name: actor.agentName, color: this.presenceColor ?? agentColor({ id: actor.agentId }) },
          forUser: { id: actor.onBehalfOf.userId, name: actor.onBehalfOf.displayName },
          ...(opts.what ? { summary: opts.what } : {}),
          ...(opts.why ? { reason: opts.why } : {}),
        }, this.now().getTime())
      }
      const send = async (): Promise<void> => {
        const update = edit.changes()
        if (!update) return
        await this.write({ ops: [{ target: 'document', docId, update: b64(update) }] })
        edit.sent()
      }
      // La suite des longs textes : chaque morceau a sa place, apres ceux deja ecrits.
      const steps: { at: number; chunk: string }[] = []
      let typed = 0
      for (const tail of plan.tails) {
        let at = tail.at + typed
        for (const chunk of tail.chunks) {
          steps.push({ at, chunk })
          at += chunk.length
          typed += chunk.length
        }
      }
      // De la fin vers le debut : les positions d'avant restent justes.
      tracker.capture(() => edit.doc.transact(() => {
        for (let i = plan.first.length - 1; i >= 0; i--) {
          const c = plan.first[i]!
          if (c.to > c.from) text.delete(c.from, c.to - c.from)
          if (c.text) text.insert(c.from, c.text)
        }
      }))
      // Une seule ecriture : le point part avec elle.
      if (!steps.length) point()
      await send()
      for (let i = 0; i < steps.length; i++) {
        await sleep(plan.delayMs)
        tracker.capture(() => text.insert(steps[i]!.at, steps[i]!.chunk))
        // Le dernier morceau emporte le point.
        if (i === steps.length - 1) point()
        try {
          await send()
        } catch {
          // Une ecriture echoue en route : le reste part d'un coup, pour ne pas laisser un texte coupe.
          // Le point part avec ce reste (s'il n'est pas deja en attente, avec le dernier morceau).
          if (i < steps.length - 1) {
            tracker.capture(() => { for (const s of steps.slice(i + 1)) text.insert(s.at, s.chunk) })
            point()
          }
          try {
            await send()
          } catch {
            throw new HostError('Écriture interrompue : seul le début du texte est dans la note. Relisez-la avant de reprendre.', 'unavailable')
          }
          return
        }
      }
    } finally {
      edit.doc.destroy()
    }
  }

  /** Les positions relatives d'une ancre, resolues dans le journal de la note. */
  async resolveRelative(docId: string, start: string, end: string): Promise<{ from: number; to: number } | null> {
    return resolveRelativeRange((await this.noteLog(docId)).updates, start, end)
  }

  async createNote(path: string, content: string): Promise<HostNoteRef> {
    const tree = await this.f.treeLog()
    const id = crypto.randomUUID()
    const folders = parentFolders(path)
    await this.write({
      register: [id],
      folders: [{ docId: id, folder: folders.at(-1) ?? '' }],
      ops: [
        { target: 'vault', update: b64(treeSetUpdate(tree?.updates ?? [], id, { path }, folders)) },
        ...(content ? [{ target: 'document' as const, docId: id, update: b64(newNoteUpdate(content)) }] : []),
      ],
    })
    this.moved.set(id, path)
    return { id, path }
  }

  async attachFile(fileId: string, path: string, noteId: string | undefined): Promise<HostNoteRef> {
    const tree = await this.f.treeLog()
    const folders = parentFolders(path)
    // Le serveur verifie que fileId est un fichier qu'il vient de recevoir, pas encore inscrit.
    // Ses octets sont gardes tels quels : « binary », pour que l'appli les lise ainsi.
    await this.write({
      register: [fileId],
      folders: [{ docId: fileId, folder: folders.at(-1) ?? '' }],
      attach: [{ docId: fileId, ...(noteId ? { noteId } : {}), name: path.slice(path.lastIndexOf('/') + 1) }],
      ops: [{ target: 'vault', update: b64(treeSetUpdate(tree?.updates ?? [], fileId, { path, binary: true }, folders)) }],
    })
    this.moved.set(fileId, path)
    return { id: fileId, path }
  }

  async createFolder(path: string): Promise<void> {
    const tree = await this.f.treeLog()
    // Un dossier vide n'a pas de document : seule l'arborescence change (droit d'ecrire dans le vault).
    await this.write({ ops: [{ target: 'vault', update: b64(treeFoldersUpdate(tree?.updates ?? [], parentFolders(`${path}/x`))) }] })
  }

  async moveNote(docId: string, newPath: string): Promise<string> {
    const from = (await this.paths()).get(docId)
    if (!from) throw new HostError('Note introuvable.', 'not_found')
    await this.moveFiles([{ from, to: newPath }])
    return newPath
  }

  /**
   * Deplace des notes (chemins avant -> apres), puis le canal des deplacements
   * (plugin-api/relink.ts), le meme que dans l'appli : les liens des notes qui
   * les citent suivent. Rend le nombre de notes dont les liens ont change.
   */
  async moveFiles(moves: readonly { from: string; to: string }[]): Promise<number> {
    const paths = await this.paths()
    const byPath = new Map([...paths].filter(([id, p]) => this.visible(id, p)).map(([id, p]) => [p, id]))
    const real: { id: string; from: string; to: string }[] = []
    for (const m of moves) {
      if (m.from === m.to) continue
      const id = byPath.get(m.from)
      if (!id) throw new HostError(`Note introuvable : ${m.from}.`, 'not_found')
      real.push({ id, ...m })
    }
    for (const m of real) {
      const tree = await this.f.treeLog()
      const folders = parentFolders(m.to)
      await this.write({
        folders: [{ docId: m.id, folder: folders.at(-1) ?? '' }],
        ops: [{ target: 'vault', update: b64(treeSetUpdate(tree?.updates ?? [], m.id, { path: m.to }, folders)) }],
      })
      this.moved.set(m.id, m.to)
    }
    if (!real.length) return 0
    return relinkAfterMoves(this.relinkVault(new Map(real.map(m => [m.id, m.to]))), real, async names => {
      const r = await this.f.call('links', 'citing', { names }) as { items?: { path: string }[] }
      return r.items ?? []
    })
  }

  /** Le vault vu par le canal des deplacements : chemins d'apres, editText par difference Yjs. */
  private relinkVault(moved: ReadonlyMap<string, string>): RelinkVault {
    const pathsAfter = async (): Promise<Map<string, string>> => {
      const m = new Map(await this.paths())
      for (const [id, to] of moved) m.set(id, to)
      return m
    }
    let after: Map<string, string> | null = null
    const byPath = async (path: string): Promise<string | undefined> => {
      after ??= await pathsAfter()
      for (const [id, p] of after) if (p === path) return id
      return undefined
    }
    return {
      list: async dir => {
        after ??= await pathsAfter()
        const prefix = dir ? (dir.endsWith('/') ? dir : `${dir}/`) : ''
        const out = new Set<string>()
        for (const [id, p] of after) {
          if (!p.startsWith(prefix) || isTrash(p) || !this.visible(id, p)) continue
          const rest = p.slice(prefix.length)
          const i = rest.indexOf('/')
          out.add(i < 0 ? p : `${prefix}${rest.slice(0, i)}/`)
        }
        return [...out].sort()
      },
      readDocumentByPath: async path => {
        const id = await byPath(path)
        if (!id) throw new HostError('Note introuvable.', 'not_found')
        return noteText((await this.noteLog(id)).updates)
      },
      // Synchrone dans l'interface : les chemins d'apres sont deja lus par list().
      resolveDocumentId: path => {
        if (!after) return undefined
        for (const [id, p] of after) if (p === path) return id
        return undefined
      },
      editText: (id, edit) => this.editNote(id, edit),
    }
  }

  // ── Pour la PluginAPI sans ecran (pluginApi.ts) ──────────────────────────

  /**
   * Les notes et les bases visibles par la personne : id -> chemin (hors
   * corbeille, ACL). L'index, complete par l'arborescence : les bases (l'index
   * ne garde que leurs lignes) et ce qui vient d'etre cree.
   */
  async visiblePaths(): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    for (const [id, p] of await this.paths()) if (this.visible(id, p)) out.set(id, p)
    for (const [id, p] of await this.treeDocs()) if (!out.has(id) && this.visible(id, p)) out.set(id, p)
    return out
  }

  /** Le texte d'une note, relu dans son journal Yjs (sinon le texte extrait). */
  async noteText(docId: string): Promise<string> {
    const path = await this.pathOf(docId)
    if (!path || !this.visible(docId, path)) throw new HostError('Note introuvable.', 'not_found')
    const log = await this.f.docLog(docId)
    if (log && log.format === 'yjs') return noteText(log.updates)
    if (!log && this.moved.has(docId)) return '' // creee par cet appel, encore sans texte
    const text = await this.f.readText(docId, path)
    if (text === null) throw new HostError('Note illisible.', 'not_found')
    return text
  }

  /**
   * Le journal Yjs d'un document a ouvrir en arbre (un dessin...) : vide s'il
   * vient d'etre cree par cet appel. Memes regles de visibilite que les notes.
   */
  async docUpdates(docId: string): Promise<string[]> {
    // Un annexe (« id~lot-003 » : un lot de lignes d'une base) suit son document, et peut ne pas exister encore.
    const cut = docId.indexOf('~')
    const owner = cut < 0 ? docId : docId.slice(0, cut)
    const path = await this.pathOf(owner)
    if (!path || !this.visible(owner, path)) throw new HostError('Document introuvable.', 'not_found')
    const log = await this.f.docLog(docId)
    if (!log) {
      if (this.moved.has(docId) || owner !== docId) return []
      throw new HostError('Document introuvable.', 'not_found')
    }
    if (log.format !== 'yjs') throw new HostError('Ce document n’est pas un document partagé modifiable ici.', 'invalid')
    return log.updates
  }

  /** Envoie au serveur une modification d'un document (une mise a jour Yjs, la difference seule). */
  async writeDocument(docId: string, update: Uint8Array): Promise<void> {
    await this.writeDocuments([{ docId, update }])
  }

  /** Plusieurs documents d'un coup (une base et ses lots) : une ecriture, coupee si elle est trop longue. */
  async writeDocuments(docs: readonly { docId: string; update: Uint8Array }[]): Promise<void> {
    for (let i = 0; i < docs.length; i += MAX_WRITE_OPS) {
      await this.write({ ops: docs.slice(i, i + MAX_WRITE_OPS).map(d => ({ target: 'document' as const, docId: d.docId, update: b64(d.update) })) })
    }
  }

  /** Le journal des types des proprietes du vault ; vide si aucun n'est declare. */
  async typeUpdates(): Promise<string[]> {
    const log = await this.f.typesLog()
    return log && log.format === 'yjs' ? log.updates : []
  }

  /** Envoie une modification des types des proprietes (le serveur la refuse en mode proposition). */
  async writeTypes(update: Uint8Array): Promise<void> {
    await this.write({ ops: [{ target: 'index', ns: TYPES_NS, update: b64(update) }] })
  }

  /** Applique `edit` au texte du moment : la difference seulement part au serveur. */
  async editNote(docId: string, edit: (current: string) => string): Promise<boolean> {
    const fresh = await this.f.docLog(docId)
    if (!fresh && (await this.paths()).has(docId)) {
      // Note toute neuve (createNote sans texte) : pas encore de journal.
      const next = edit('')
      if (!next) return false
      await this.write({ ops: [{ target: 'document', docId, update: b64(newNoteUpdate(next)) }] })
      return true
    }
    const log = await this.noteLog(docId)
    const current = noteText(log.updates)
    const next = edit(current)
    if (next === current) return false
    const c = minimalChange(current, next)
    await this.write({ ops: [{ target: 'document', docId, update: b64(replaceTextUpdate(log.updates, c.from, c.to, c.text)) }] })
    return true
  }

  /** Une proposition d'un plugin (« base.cell », « savoire.text »...), comme ReviewService.propose. */
  async propose(docId: string, type: string, payload: unknown, note: string, actor: ToolActor): Promise<string> {
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(type)) throw new HostError('Type de proposition invalide.')
    const json = JSON.stringify(payload)
    if (json === undefined) throw new HostError('Proposition vide.')
    if (new TextEncoder().encode(json).length > MAX_PROPOSAL_BYTES) throw new HostError('Proposition trop grosse.')
    return this.addReview({ docId, kind: 'proposal', text: note.trim() || 'Proposition', status: 'open', proposalType: type, payload: JSON.parse(json) }, actor)
  }

  async trashNote(docId: string): Promise<string> {
    const tree = await this.f.treeLog()
    const paths = await this.paths()
    const path = paths.get(docId)
    if (!path) throw new HostError('Note introuvable.', 'not_found')
    if (isTrash(path)) return path
    const taken = new Set(paths.values())
    const target = uniquePath(TRASH_DIR + path, p => taken.has(p))
    await this.write({
      folders: [{ docId, folder: parentFolders(target).at(-1) ?? '' }],
      ops: [{ target: 'vault', update: b64(treeSetUpdate(tree?.updates ?? [], docId, { path: target })) }],
    })
    this.moved.set(docId, target)
    return target
  }

  // ── Revision ─────────────────────────────────────────────────────────────

  private async addReview(entry: Omit<ReviewValue, 'id' | 'createdAt' | 'author'> & { anchor?: unknown }, actor: ToolActor): Promise<string> {
    const log = await this.f.reviewLog()
    const id = crypto.randomUUID()
    const value = {
      ...entry, id, createdAt: this.now().toISOString(),
      author: { kind: 'agent', agentId: actor.agentId, agentName: actor.agentName, onBehalfOf: actor.onBehalfOf },
    }
    await this.write({ ops: [{ target: 'index', ns: REVIEW_NS, update: b64(mapEntryUpdate(log?.updates ?? [], id, value)) }] })
    return id
  }

  async comment(docId: string, text: string, actor: ToolActor, range?: { from: number; to: number }): Promise<string> {
    const anchor = range ? textAnchor((await this.noteLog(docId)).updates, range.from, range.to) : undefined
    return this.addReview({ docId, kind: 'comment', text: text.trim(), status: 'open', ...(anchor ? { anchor } : {}) }, actor)
  }

  async reply(rootId: string, text: string, actor: ToolActor): Promise<string> {
    const all = await this.reviewValues()
    let root = all.find(e => e.id === rootId)
    while (root?.parentId) root = all.find(e => e.id === root!.parentId)
    if (!root) throw new HostError(`Fil introuvable : ${rootId}.`, 'not_found')
    const paths = await this.paths()
    if (!this.visible(root.docId, paths.get(root.docId) ?? '')) throw new HostError(`Fil introuvable : ${rootId}.`, 'not_found')
    return this.addReview({ docId: root.docId, kind: 'comment', text: text.trim(), parentId: root.id }, actor)
  }

  async suggest(docId: string, from: number, to: number, replacement: string, actor: ToolActor, note: string): Promise<string> {
    const anchor = textAnchor((await this.noteLog(docId)).updates, from, to)
    if (anchor.quote === replacement) throw new HostError('La suggestion ne change rien.')
    return this.addReview({ docId, kind: 'suggestion', text: note.trim() || 'Suggestion', status: 'open', anchor, replacement }, actor)
  }

  async recordEdit(docId: string, text: string, actor: ToolActor): Promise<void> {
    await this.addReview({ docId, kind: 'edit', text }, actor)
  }
}

/** Un appel `tools.*`, pour un vault. `plugins` : les outils serveur des plugins (serverPlugins.ts). */
export async function callTools(f: PeerVaultFacade, method: string, params: unknown, plugins?: ServerPluginSet): Promise<unknown> {
  if (method === 'list') {
    const core = coreCatalog('server')
    const taken = new Set(core.map(t => t.name))
    return { tools: [...core, ...(plugins ? (await plugins.specs()).filter(s => !taken.has(s.name)) : [])] }
  }
  if (method !== 'call') throw new HttpError(404, 'unknown_method', `Methode inconnue : tools.${method}.`)
  const p = (params ?? {}) as { name?: unknown; args?: unknown; mode?: unknown; agent?: unknown; actor?: unknown; ticket?: unknown; access?: unknown; typing?: unknown }
  if (typeof p.name !== 'string' || typeof p.ticket !== 'string' || !p.agent || typeof p.agent !== 'object' || !p.actor || typeof p.actor !== 'object') {
    throw new HttpError(400, 'invalid_query', 'tools.call : name, agent, actor et ticket attendus.')
  }
  const args = p.args && typeof p.args === 'object' && !Array.isArray(p.args) ? p.args as Record<string, unknown> : {}
  const agent = p.agent as AgentDefinition
  const actor = p.actor as ToolActor
  const host = new PeerToolHost(f, parseAccess(p.access), p.ticket)
  host.presenceColor = agentColor(agent)
  host.typingSpot = parseTypingSpot(p.typing)
  // Un outil de plugin : ses lectures et ecritures passent par le meme hote (ticket, ACL).
  const pluginTools = plugins && !coreCatalog('server').some(t => t.name === p.name) && (await plugins.specs()).some(s => s.name === p.name)
    ? await plugins.tools({ host, actor, paths: await host.visiblePaths() })
    : []
  // Le serveur a verifie les droits de la personne et recueilli l'accord : il impose le mode.
  const tools = new ToolBox({ agent, person: { canWrite: true }, actor, runtime: 'server', host, pluginTools, imposedMode: p.mode === 'propose' ? 'propose' : 'direct' })
  try {
    const outcome = await tools.call(p.name, args)
    return { text: outcome.result.text, isError: !!outcome.result.isError, ...(outcome.result.sources ? { sources: outcome.result.sources } : {}) }
  } finally {
    await host.presenceSettled()
  }
}
