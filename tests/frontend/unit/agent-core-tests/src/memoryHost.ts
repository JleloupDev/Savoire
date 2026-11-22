// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Un hote en memoire pour tester les outils et le moteur sans vault.
import type { AgentToolHost, HostNote, HostNoteRef, HostReviewEntry } from '@savoire/agent-core'
import { HostError, titleOf } from '@savoire/agent-core'
import type { ToolActor } from '@savoire/plugin-api'

export class MemoryHost implements AgentToolHost {
  notes = new Map<string, { path: string; content: string }>()
  review: (HostReviewEntry & { docId: string; from?: number; to?: number })[] = []
  folders = new Set<string>()
  writes: string[] = []
  /** Chemins caches a la personne (ACL). */
  hidden = new Set<string>()
  private n = 0

  constructor(notes: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(notes)) this.notes.set(`id-${++this.n}`, { path, content })
  }

  idOf(path: string): string {
    for (const [id, n] of this.notes) if (n.path === path) return id
    throw new Error(`pas de note ${path}`)
  }

  content(path: string): string {
    return this.notes.get(this.idOf(path))!.content
  }

  private visible(): [string, { path: string; content: string }][] {
    return [...this.notes].filter(([, n]) => !this.hidden.has(n.path) && !n.path.startsWith('.trash/'))
  }

  async listNotes(p: { folder?: string; limit: number }): Promise<{ items: HostNoteRef[]; total: number }> {
    const items = this.visible().filter(([, n]) => !p.folder || n.path.startsWith(`${p.folder}/`)).map(([id, n]) => ({ id, path: n.path }))
    return { items: items.slice(0, p.limit), total: items.length }
  }

  async search(p: { text: string; limit: number }) {
    const words = p.text.toLowerCase().split(/\s+/)
    return this.visible()
      .filter(([, n]) => words.every(w => n.content.toLowerCase().includes(w)))
      .slice(0, p.limit)
      .map(([id, n]) => ({ id, path: n.path, title: titleOf(n.path), snippets: [n.content.slice(0, 60)] }))
  }

  async findNote(ref: { id?: string; path?: string }): Promise<HostNoteRef | null> {
    const hit = this.visible().find(([id, n]) => (ref.id && id === ref.id) || (ref.path && n.path.toLowerCase() === ref.path.toLowerCase()))
    return hit ? { id: hit[0], path: hit[1].path } : null
  }

  async readNote(ref: { id?: string; path?: string }): Promise<HostNote | null> {
    const hit = this.visible().find(([id, n]) => (ref.id && id === ref.id) || (ref.path && n.path.toLowerCase() === ref.path.toLowerCase()))
    return hit ? { id: hit[0], path: hit[1].path, title: titleOf(hit[1].path), content: hit[1].content } : null
  }

  async power(capability: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    if (capability === 'links' && method === 'backlinks') {
      const target = this.notes.get(params.id as string)!
      const name = titleOf(target.path)
      return { items: this.visible().filter(([, n]) => n.content.includes(`[[${name}]]`)).map(([id, n]) => ({ id, path: n.path, title: titleOf(n.path), count: 1 })) }
    }
    return null
  }

  async listReview(docId: string): Promise<HostReviewEntry[]> {
    return this.review.filter(e => e.docId === docId)
  }

  private writable(docId: string): { path: string; content: string } {
    const n = this.notes.get(docId)
    if (!n || this.hidden.has(n.path)) throw new HostError('Note introuvable.', 'not_found')
    return n
  }

  async replaceText(docId: string, from: number, to: number, text: string, actor: ToolActor): Promise<void> {
    const n = this.writable(docId)
    n.content = n.content.slice(0, from) + text + n.content.slice(to)
    this.writes.push(`replace ${n.path} par ${actor.agentName}`)
  }

  async createNote(path: string, content: string): Promise<HostNoteRef> {
    const id = `id-${++this.n}`
    this.notes.set(id, { path, content })
    this.writes.push(`create ${path}`)
    return { id, path }
  }

  async createFolder(path: string): Promise<void> {
    this.folders.add(path)
  }

  async moveNote(docId: string, newPath: string): Promise<string> {
    this.writable(docId).path = newPath
    this.writes.push(`move ${newPath}`)
    return newPath
  }

  async trashNote(docId: string): Promise<string> {
    const n = this.writable(docId)
    n.path = `.trash/${n.path}`
    return n.path
  }

  /** Fichiers inscrits par attachFile : id -> note. */
  attached = new Map<string, string>()

  async attachFile(fileId: string, path: string, noteId: string): Promise<HostNoteRef> {
    this.notes.set(fileId, { path, content: '' })
    this.attached.set(fileId, noteId)
    return { id: fileId, path }
  }

  private entry(docId: string, kind: HostReviewEntry['kind'], text: string, actor: ToolActor, extra: Partial<HostReviewEntry & { from: number; to: number }> = {}): string {
    const id = `r-${this.review.length + 1}`
    this.review.push({ id, docId, kind, text, author: `${actor.agentName} (IA), pour ${actor.onBehalfOf.displayName}`, authorIsAgent: true, createdAt: '2026-11-18T00:00:00Z', ...extra })
    return id
  }

  async comment(docId: string, text: string, actor: ToolActor, range?: { from: number; to: number }): Promise<string> {
    return this.entry(docId, 'comment', text, actor, range ?? {})
  }

  async reply(rootId: string, text: string, actor: ToolActor): Promise<string> {
    const root = this.review.find(e => e.id === rootId)
    if (!root) throw new HostError('fil introuvable', 'not_found')
    return this.entry(root.docId, 'comment', text, actor, { parentId: rootId })
  }

  async suggest(docId: string, from: number, to: number, replacement: string, actor: ToolActor, note: string): Promise<string> {
    const n = this.writable(docId)
    return this.entry(docId, 'suggestion', note, actor, { from, to, quote: n.content.slice(from, to), replacement })
  }

  async recordEdit(docId: string, text: string, actor: ToolActor): Promise<void> {
    this.entry(docId, 'edit', text, actor)
  }
}
