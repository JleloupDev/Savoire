// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// L'hote des outils d'agent dans l'appli (ADR-033) : les outils du socle
// (@savoire/agent-core) au-dessus de la session du vault ouvert.
//
// Tout passe par les memes chemins que la personne : VaultClient pour lire,
// creer, deplacer ; le CRDT de la note pour modifier un passage ; la Revision
// pour commenter et proposer. Le serveur verifie donc les memes droits (ACL)
// que pour elle. L'auteur des commentaires et propositions est l'agent :
// « Archiviste (IA), pour Jean ».
import { HostError, notePath, titleOf, type AgentToolHost, type HostHit, type HostNote, type HostNoteRef, type HostReviewEntry } from '@savoire/agent-core'
import { describeActor, ReviewService, type AgentActor, type IVaultSyncSession } from '@savoire/application'
import type { VaultClient } from '@savoire/platform'
import type { ICRDT, PluginAPI, ToolActor } from '@savoire/plugin-api'
import { reviewFor } from '../reviewProposals'

/** Un document ouvert pour ecrire reste ouvert un moment : ses operations partent avant la fermeture. */
const CLOSE_DELAY_MS = 3000
const MAX_READ = 512 * 1024

export interface AppToolHostDeps {
  client: VaultClient
  session: IVaultSyncSession
  /** La PluginAPI de l'appli : recherche, pouvoirs de l'index, requetes. */
  api: Pick<PluginAPI, 'search' | 'indexer' | 'query'> | null
}

function agentActor(a: ToolActor): AgentActor {
  return { kind: 'agent', agentId: a.agentId, agentName: a.agentName, onBehalfOf: a.onBehalfOf }
}

const isTrash = (path: string): boolean => path.startsWith('.trash/')

export class AppToolHost implements AgentToolHost {
  constructor(private readonly d: AppToolHostDeps) {}

  private get review(): ReviewService {
    return reviewFor(this.d.session)
  }

  private notes(): HostNoteRef[] {
    return this.d.client.documents.filter(m => !isTrash(m.path)).map(m => ({ id: m.id, path: m.path }))
  }

  private find(ref: { id?: string; path?: string }): HostNoteRef | undefined {
    const all = this.notes()
    if (ref.id) return all.find(n => n.id === ref.id)
    const wanted = ref.path ?? ''
    const fold = wanted.toLowerCase()
    return all.find(n => n.path === wanted) ?? all.find(n => n.path.toLowerCase() === fold)
      ?? all.find(n => n.path.toLowerCase() === `${fold}.md`)
  }

  /** Le texte collaboratif d'une note, a jour, le temps de `use`. */
  private async withText<T>(docId: string, use: (t: { content: string; replace(from: number, to: number, text: string): void; anchor(from: number, to: number): ReturnType<typeof ReviewService.anchor> }) => T): Promise<T> {
    const { session } = this.d
    const crdt = session.openDocument(docId) as ICRDT
    try {
      await session.documentLoaded?.(docId)
      const collab = crdt.collaborativeText?.()
      const shared = crdt.sharedText?.()
      if (!collab || !shared) throw new HostError('Cette note n’est pas un texte modifiable.', 'invalid')
      return use({
        content: collab.toString(),
        replace: (from, to, text) => shared.applyDelta([
          ...(from > 0 ? [{ retain: from }] : []),
          ...(to > from ? [{ delete: to - from }] : []),
          ...(text ? [{ insert: text }] : []),
        ]),
        anchor: (from, to) => ReviewService.anchor(collab, from, to),
      })
    } finally {
      setTimeout(() => session.closeDocument(docId), CLOSE_DELAY_MS)
    }
  }

  // ── Lecture ──────────────────────────────────────────────────────────────

  async listNotes(p: { folder?: string; limit: number; cursor?: string }): Promise<{ items: HostNoteRef[]; total: number; next?: string }> {
    const prefix = p.folder ? `${p.folder.replace(/\/+$/, '')}/` : ''
    const all = this.notes().filter(n => n.path.startsWith(prefix)).sort((a, b) => a.path.localeCompare(b.path))
    const start = Math.max(0, Number(p.cursor ?? 0) || 0)
    const page = all.slice(start, start + p.limit)
    return { items: page, total: all.length, ...(start + p.limit < all.length ? { next: String(start + p.limit) } : {}) }
  }

  async search(p: { text: string; limit: number; folder?: string }): Promise<HostHit[]> {
    const engine = this.d.api?.search
    if (!engine) throw new HostError('Recherche indisponible.', 'unavailable')
    const r = await engine.search({ text: p.text, limit: p.limit, ...(p.folder ? { folder: p.folder } : {}) })
    return r.hits.map(h => ({ id: h.id, path: h.path, title: h.title, snippets: h.snippets.map(s => s.text) }))
  }

  async readNote(ref: { id?: string; path?: string }): Promise<HostNote | null> {
    const n = this.find(ref)
    if (!n) return null
    try {
      const content = await this.d.client.read(n.id)
      const truncated = content.length > MAX_READ
      return { ...n, title: titleOf(n.path), content: truncated ? content.slice(0, MAX_READ) : content, ...(truncated ? { truncated } : {}) }
    } catch {
      // Refusee par le serveur (ACL), ou illisible : elle n'existe pas pour l'agent.
      return null
    }
  }

  async power(capability: string, method: string, params: Record<string, unknown>): Promise<unknown | null> {
    const api = this.d.api
    if (capability === 'query' && method === 'run') return api?.query ? api.query.query(params as never) : null
    const idx = api?.indexer
    if (!idx?.available()) return null
    if (capability === 'links') {
      if (method === 'backlinks') return idx.links.backlinks(params as never)
      if (method === 'outgoing') return idx.links.outgoing(params as never)
      if (method === 'unresolved') return idx.links.unresolved(params as never)
    }
    if (capability === 'tags') {
      if (method === 'list') return idx.tags.list(params as never)
      if (method === 'notes') return idx.tags.notes(params as never)
    }
    return null
  }

  async listReview(docId: string): Promise<HostReviewEntry[]> {
    return this.review.list(docId).map(e => ({
      id: e.id, kind: e.kind, text: e.text, author: describeActor(e.author), authorIsAgent: e.author.kind === 'agent', createdAt: e.createdAt,
      ...(e.status ? { status: e.status } : {}), ...(e.parentId ? { parentId: e.parentId } : {}),
      ...(e.anchor ? { quote: e.anchor.quote } : {}), ...(e.replacement !== undefined ? { replacement: e.replacement } : {}),
    }))
  }

  // ── Ecriture ─────────────────────────────────────────────────────────────

  async replaceText(docId: string, from: number, to: number, text: string): Promise<void> {
    await this.withText(docId, t => {
      if (to > t.content.length) throw new HostError('La note a changé pendant la modification : relisez-la.', 'conflict')
      t.replace(from, to, text)
    })
  }

  async createNote(path: string, content: string): Promise<HostNoteRef> {
    const target = notePath(path)
    await this.ensureFolder(target)
    await this.d.client.createFile(target)
    const created = this.find({ path: target })
    if (!created) throw new HostError('La note n’a pas pu être créée.', 'unavailable')
    if (content) await this.withText(created.id, t => t.replace(0, 0, content))
    return created
  }

  private async ensureFolder(path: string): Promise<void> {
    const i = path.lastIndexOf('/')
    if (i > 0) await this.d.client.createFolder(path.slice(0, i))
  }

  async createFolder(path: string): Promise<void> {
    await this.d.client.createFolder(path)
  }

  async moveNote(docId: string, newPath: string): Promise<string> {
    await this.ensureFolder(newPath)
    await this.d.client.renameFile(docId, newPath)
    return this.find({ id: docId })?.path ?? newPath
  }

  async trashNote(docId: string): Promise<string> {
    const at = this.d.client.trash(docId)
    if (!at) throw new HostError('Note introuvable.', 'not_found')
    return at
  }

  // ── Revision ─────────────────────────────────────────────────────────────

  async comment(docId: string, text: string, actor: ToolActor, range?: { from: number; to: number }): Promise<string> {
    const anchor = range ? await this.withText(docId, t => t.anchor(range.from, range.to)) : undefined
    return this.review.comment(docId, text, agentActor(actor), anchor).id
  }

  async reply(rootId: string, text: string, actor: ToolActor): Promise<string> {
    return this.review.reply(rootId, text, agentActor(actor)).id
  }

  async suggest(docId: string, from: number, to: number, replacement: string, actor: ToolActor, note: string): Promise<string> {
    const anchor = await this.withText(docId, t => t.anchor(from, to))
    return this.review.suggest(docId, anchor, replacement, agentActor(actor), note).id
  }

  async recordEdit(docId: string, text: string, actor: ToolActor): Promise<void> {
    this.review.recordEdit(docId, text, agentActor(actor))
  }
}
