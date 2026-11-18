// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Pouvoir « tools » : les outils des agents, executes par le pair pour les IA
// externes (ChatGPT, Claude), ADR-033.
//
//   tools.list  {}                         -> { tools: ToolSpec[] }   (catalogue du socle)
//   tools.call  { name, args, mode, agent, actor, ticket, access }
//               -> { text, isError, sources? }
//
// Seul le serveur appelle ce pouvoir (la route publique le refuse). Il a deja
// verifie l'agent, le vault et le mode ; il joint un TICKET d'ecriture et les
// regles d'acces de la personne. Les outils sont ceux de @savoire/agent-core,
// au-dessus d'un hote qui lit les journaux Yjs et renvoie au serveur ce qu'il
// ecrit (POST /internal/indexer/vaults/{id}/write). Le serveur reverifie tout.
import {
  HostError, ToolBox, coreCatalog, minimalChange, titleOf,
  type AgentToolHost, type HostHit, type HostNote, type HostNoteRef, type HostReviewEntry,
} from '@savoire/agent-core'
import {
  mapEntries, mapEntryUpdate, newNoteUpdate, noteText, parentFolders, replaceTextUpdate, textAnchor, treeFoldersUpdate, treeSetUpdate,
} from '@savoire/indexer-core'
import { relinkAfterMoves, type AgentDefinition, type RelinkVault, type ToolActor } from '@savoire/plugin-api'
import { canRead, parseAccess, type AccessRules } from './access'
import type { UpdatesLog, WriteBody } from './backend'
import { HttpError } from './errors'

export const TOOLS_CAPABILITY = 'tools'
const REVIEW_NS = 'map/review'
const TRASH_DIR = '.trash/'
const MAX_READ = 512 * 1024

/** Ce que le magasin du vault donne a l'hote (store.ts). */
export interface PeerVaultFacade {
  /** id -> chemin, corbeille comprise. */
  paths(): Promise<Map<string, string>>
  /** Texte d'un document (note, fichier extrait, texte publie). */
  readText(id: string, path: string): Promise<string | null>
  /** Un pouvoir de l'index (search, query, links, tags). */
  call(capability: string, method: string, params: Record<string, unknown>): Promise<unknown>
  docLog(id: string): Promise<UpdatesLog | null | undefined>
  treeLog(): Promise<UpdatesLog | null>
  reviewLog(): Promise<UpdatesLog | null>
  write(body: WriteBody): Promise<void>
}

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
  author: { kind: 'user'; displayName: string } | { kind: 'agent'; agentName: string; onBehalfOf: { displayName: string } }
  createdAt: string
  parentId?: string
  status?: string
  anchor?: { quote: string }
  replacement?: string
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

  private async paths(): Promise<Map<string, string>> {
    this.pathCache ??= await this.f.paths()
    return this.pathCache
  }

  private visible(id: string, path: string): boolean {
    return !isTrash(path) && canRead(this.access, id, path)
  }

  private async find(ref: { id?: string; path?: string }): Promise<HostNoteRef | undefined> {
    const paths = await this.paths()
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

  async readNote(ref: { id?: string; path?: string }): Promise<HostNote | null> {
    const n = await this.find(ref)
    if (!n) return null
    const content = await this.f.readText(n.id, n.path)
    if (content === null) return null
    const truncated = content.length > MAX_READ
    return { ...n, title: titleOf(n.path), content: truncated ? content.slice(0, MAX_READ) : content, ...(truncated ? { truncated } : {}) }
  }

  async power(capability: string, method: string, params: Record<string, unknown>): Promise<unknown | null> {
    if (!['links', 'tags', 'query'].includes(capability)) return null
    return this.f.call(capability, method, params)
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
    }))
  }

  // ── Ecriture ─────────────────────────────────────────────────────────────

  async replaceText(docId: string, from: number, to: number, text: string): Promise<void> {
    const log = await this.noteLog(docId)
    if (to > noteText(log.updates).length) throw new HostError('La note a changé pendant la modification : relisez-la.', 'conflict')
    await this.write({ ops: [{ target: 'document', docId, update: b64(replaceTextUpdate(log.updates, from, to, text)) }] })
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
    return { id, path }
  }

  async createFolder(path: string): Promise<void> {
    const tree = await this.f.treeLog()
    // Un dossier vide n'a pas de document : seule l'arborescence change (droit d'ecrire dans le vault).
    await this.write({ ops: [{ target: 'vault', update: b64(treeFoldersUpdate(tree?.updates ?? [], parentFolders(`${path}/x`))) }] })
  }

  async moveNote(docId: string, newPath: string): Promise<string> {
    const tree = await this.f.treeLog()
    const paths = await this.paths()
    const from = paths.get(docId)
    if (!from) throw new HostError('Note introuvable.', 'not_found')
    const folders = parentFolders(newPath)
    await this.write({
      folders: [{ docId, folder: folders.at(-1) ?? '' }],
      ops: [{ target: 'vault', update: b64(treeSetUpdate(tree?.updates ?? [], docId, { path: newPath }, folders)) }],
    })
    // Le canal des deplacements (plugin-api/relink.ts), le meme que dans l'appli :
    // les liens des notes qui citent la note suivent.
    await relinkAfterMoves(this.relinkVault(docId, newPath), [{ from, to: newPath }], async names => {
      const r = await this.f.call('links', 'citing', { names }) as { items?: { path: string }[] }
      return r.items ?? []
    })
    return newPath
  }

  /** Le vault vu par le canal des deplacements : chemins d'apres, editText par difference Yjs. */
  private relinkVault(movedId: string, movedTo: string): RelinkVault {
    const pathsAfter = async (): Promise<Map<string, string>> => {
      const m = new Map(await this.paths())
      m.set(movedId, movedTo)
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
      editText: async (id, edit) => {
        const log = await this.noteLog(id)
        const current = noteText(log.updates)
        const next = edit(current)
        if (next === current) return false
        const c = minimalChange(current, next)
        await this.write({ ops: [{ target: 'document', docId: id, update: b64(replaceTextUpdate(log.updates, c.from, c.to, c.text)) }] })
        return true
      },
    }
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

/** Un appel `tools.*`, pour un vault. */
export async function callTools(f: PeerVaultFacade, method: string, params: unknown): Promise<unknown> {
  if (method === 'list') return { tools: coreCatalog('server') }
  if (method !== 'call') throw new HttpError(404, 'unknown_method', `Methode inconnue : tools.${method}.`)
  const p = (params ?? {}) as { name?: unknown; args?: unknown; mode?: unknown; agent?: unknown; actor?: unknown; ticket?: unknown; access?: unknown }
  if (typeof p.name !== 'string' || typeof p.ticket !== 'string' || !p.agent || typeof p.agent !== 'object' || !p.actor || typeof p.actor !== 'object') {
    throw new HttpError(400, 'invalid_query', 'tools.call : name, agent, actor et ticket attendus.')
  }
  const args = p.args && typeof p.args === 'object' && !Array.isArray(p.args) ? p.args as Record<string, unknown> : {}
  const agent = p.agent as AgentDefinition
  const actor = p.actor as ToolActor
  const host = new PeerToolHost(f, parseAccess(p.access), p.ticket)
  // Le serveur a verifie les droits de la personne et recueilli l'accord : il impose le mode.
  const tools = new ToolBox({ agent, person: { canWrite: true }, actor, runtime: 'server', host, imposedMode: p.mode === 'propose' ? 'propose' : 'direct' })
  const outcome = await tools.call(p.name, args)
  return { text: outcome.result.text, isError: !!outcome.result.isError, ...(outcome.result.sources ? { sources: outcome.result.sources } : {}) }
}
