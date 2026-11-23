// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Les outils du socle (ADR-033) : ecrits une fois, executes par l'appli comme
// par le pair indexeur, au-dessus d'un AgentToolHost.
//
// Chaque outil ne fait que son travail. Les droits de l'agent (mode, portee)
// sont verifies par la ToolBox AVANT ; il recoit le mode a appliquer
// ('direct' ou 'propose') et une portee a respecter pour chaque note.
import type { AgentScope, ToolActor, ToolInputSchema, ToolParamSchema, ToolResult, ToolSource, ToolSpec } from '@savoire/plugin-api'
import { HostError, type AgentToolHost, type HostNote, type HostNoteRef } from './host'
import { pathInScope } from './policy'
import { countOccurrences, findOccurrence, folderOf, notePath, setPropertyChange, titleOf } from './text'
import { alreadyReviewed, type WatchReview } from './watch'

export interface CoreToolContext {
  mode: 'direct' | 'propose'
  actor: ToolActor
  host: AgentToolHost
  scope?: AgentScope
}

export interface CoreTool {
  spec: ToolSpec
  run(args: Record<string, unknown>, ctx: CoreToolContext): Promise<ToolResult>
}

// ── Aides ──────────────────────────────────────────────────────────────────

const str = (description: string): ToolParamSchema => ({ type: 'string', description })
const int = (description: string): ToolParamSchema => ({ type: 'integer', description })
const NOTE_REF: Record<string, ToolParamSchema> = {
  path: str('Chemin de la note (ex. Projets/Plan.md).'),
  id: str('Id de la note (rendu par search ou list_notes).'),
}

function schema(properties: Record<string, ToolParamSchema>, required: string[] = []): ToolInputSchema {
  return { type: 'object', properties, required, additionalProperties: false }
}

function optString(args: Record<string, unknown>, key: string, max = 4096): string | undefined {
  const v = args[key]
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  if (!t) return undefined
  if (t.length > max) throw new HostError(`${key} : ${max} caracteres au plus.`)
  return t
}

function reqString(args: Record<string, unknown>, key: string, max = 4096): string {
  const v = optString(args, key, max)
  if (v === undefined) throw new HostError(`Argument manquant : ${key}.`)
  return v
}

/** Texte brut (espaces gardes) : contenu d'une note, remplacement. */
function rawString(args: Record<string, unknown>, key: string, max = 200_000, required = true): string {
  const v = args[key]
  if (typeof v !== 'string') {
    if (!required) return ''
    throw new HostError(`Argument manquant : ${key}.`)
  }
  if (v.length > max) throw new HostError(`${key} : ${max} caracteres au plus.`)
  return v
}

function limitOf(args: Record<string, unknown>, fallback: number, max: number): number {
  const v = args.limit
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : fallback
  return Math.max(1, Math.min(max, n))
}

function source(n: HostNoteRef & { title?: string }): ToolSource {
  return { docId: n.id, path: n.path, title: n.title ?? titleOf(n.path) }
}

function guard(ctx: CoreToolContext, path: string): void {
  if (!pathInScope(ctx.scope, path)) throw new HostError(`« ${path} » est hors de la portée de cet agent.`, 'denied')
}

async function noteArg(args: Record<string, unknown>, ctx: CoreToolContext): Promise<HostNote> {
  const id = optString(args, 'id', 200)
  const path = optString(args, 'path', 1024)
  if (!id && !path) throw new HostError('Donner path ou id.')
  const note = await ctx.host.readNote(id ? { id } : { path })
  if (!note || !pathInScope(ctx.scope, note.path)) throw new HostError(`Note introuvable : ${path ?? id}.`, 'not_found')
  return note
}

const ok = (text: string, extra: Partial<ToolResult> = {}): ToolResult => ({ text, ...extra })

/** Remplace une plage : directement (avec la trace), ou en suggestion. */
async function change(ctx: CoreToolContext, note: HostNote, from: number, to: number, text: string, what: string, why: string): Promise<ToolResult> {
  if (ctx.mode === 'propose') {
    const id = await ctx.host.suggest(note.id, from, to, text, ctx.actor, why || what)
    return ok(`Proposition déposée dans la Révision de ${note.path} (${what}). Rien ne change tant que la personne ne l'accepte pas.`,
      { data: { suggestionId: id }, sources: [source(note)] })
  }
  await ctx.host.replaceText(note.id, from, to, text, ctx.actor)
  await ctx.host.recordEdit(note.id, why ? `${what} : ${why}` : what, ctx.actor)
  return ok(`${note.path} modifiée (${what}).`, { sources: [source(note)] })
}

// ── Lecture ────────────────────────────────────────────────────────────────

const RUNTIMES = ['app', 'server'] as const

const search: CoreTool = {
  spec: {
    name: 'search', title: 'Chercher', action: 'read', runtimes: [...RUNTIMES],
    description: 'Recherche plein texte dans les notes et fichiers du vault. Rend les notes trouvées avec un extrait. Guillemets pour une expression exacte.',
    inputSchema: schema({ query: str('Mots à chercher.'), limit: int('Nombre de résultats (1 à 50, 10 par défaut).'), folder: str('Limiter à un dossier.') }, ['query']),
  },
  async run(args, ctx) {
    const text = reqString(args, 'query', 500)
    const hits = (await ctx.host.search({ text, limit: limitOf(args, 10, 50), folder: optString(args, 'folder', 1024) }))
      .filter(h => pathInScope(ctx.scope, h.path))
    if (!hits.length) return ok(`Aucun résultat pour « ${text} ».`, { data: { hits: [] } })
    const lines = hits.map(h => `- ${h.title ?? titleOf(h.path)} — ${h.path} (id : ${h.id})${(h.snippets ?? []).slice(0, 2).map(s => `\n  « ${s} »`).join('')}`)
    return ok(`${hits.length} résultat(s) :\n${lines.join('\n')}`, { data: { hits }, sources: hits.map(source) })
  },
}

const readNote: CoreTool = {
  spec: {
    name: 'read_note', title: 'Lire une note', action: 'read', runtimes: [...RUNTIMES],
    description: 'Rend le texte complet d’une note en Markdown (ou le texte d’un fichier), par son chemin ou son id.',
    inputSchema: schema({ ...NOTE_REF }),
  },
  async run(args, ctx) {
    const note = await noteArg(args, ctx)
    const tail = note.truncated ? '\n\n[Texte tronqué : note trop longue.]' : ''
    return ok(`# ${note.path} (id : ${note.id})\n\n${note.content}${tail}`, { data: { id: note.id, path: note.path, length: note.content.length }, sources: [source(note)] })
  },
}

const listNotes: CoreTool = {
  spec: {
    name: 'list_notes', title: 'Lister les notes', action: 'read', runtimes: [...RUNTIMES],
    description: 'Liste les notes du vault, ou d’un dossier, par chemin.',
    inputSchema: schema({ folder: str('Dossier (facultatif).'), limit: int('Nombre de notes (1 à 200, 50 par défaut).'), cursor: str('Suite d’une liste précédente (champ next).') }),
  },
  async run(args, ctx) {
    const r = await ctx.host.listNotes({ folder: optString(args, 'folder', 1024), limit: limitOf(args, 50, 200), cursor: optString(args, 'cursor', 2000) })
    const items = r.items.filter(i => pathInScope(ctx.scope, i.path))
    const lines = items.map(i => `- ${i.path} (id : ${i.id})`)
    const more = r.next ? `\nSuite : cursor = ${r.next}` : ''
    return ok(`${r.total ?? items.length} note(s) :\n${lines.join('\n')}${more}`, { data: { items, next: r.next } })
  },
}

async function power(ctx: CoreToolContext, capability: string, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await ctx.host.power(capability, method, params)
  if (r === null || typeof r !== 'object') throw new HostError('Index indisponible pour le moment : réessayez plus tard.', 'unavailable')
  return r as Record<string, unknown>
}

type Item = { id: string; path: string; title?: string; count?: number }
const items = (v: unknown): Item[] => Array.isArray(v) ? v.filter((x): x is Item => !!x && typeof (x as Item).id === 'string' && typeof (x as Item).path === 'string') : []

const backlinks: CoreTool = {
  spec: {
    name: 'backlinks', title: 'Rétroliens', action: 'read', runtimes: [...RUNTIMES],
    description: 'Les notes qui pointent vers cette note (liens [[...]]).',
    inputSchema: schema({ ...NOTE_REF, limit: int('Nombre de notes (1 à 200, 50 par défaut).') }),
  },
  async run(args, ctx) {
    const note = await noteArg(args, ctx)
    const r = await power(ctx, 'links', 'backlinks', { id: note.id, limit: limitOf(args, 50, 200) })
    const list = items(r.items).filter(i => pathInScope(ctx.scope, i.path))
    if (!list.length) return ok(`Aucune note ne pointe vers ${note.path}.`, { data: { items: [] } })
    return ok(`${list.length} note(s) pointent vers ${note.path} :\n${list.map(i => `- ${i.path} (id : ${i.id})${i.count && i.count > 1 ? ` ×${i.count}` : ''}`).join('\n')}`,
      { data: { items: list }, sources: list.map(source) })
  },
}

const outgoingLinks: CoreTool = {
  spec: {
    name: 'outgoing_links', title: 'Liens sortants', action: 'read', runtimes: [...RUNTIMES],
    description: 'Les liens d’une note : ceux qui mènent à une note, et ceux qui sont cassés.',
    inputSchema: schema({ ...NOTE_REF }),
  },
  async run(args, ctx) {
    const note = await noteArg(args, ctx)
    const r = await power(ctx, 'links', 'outgoing', { id: note.id })
    const resolved = items(r.resolved).filter(i => pathInScope(ctx.scope, i.path))
    const broken = Array.isArray(r.unresolved) ? (r.unresolved as { target?: string }[]).map(u => u?.target).filter((t): t is string => typeof t === 'string') : []
    const text = [`Liens de ${note.path} :`, ...resolved.map(i => `- ${i.path} (id : ${i.id})`), ...(broken.length ? ['Liens cassés :', ...broken.map(t => `- [[${t}]]`)] : [])]
    return ok(text.join('\n'), { data: { resolved, unresolved: broken }, sources: resolved.map(source) })
  },
}

const brokenLinks: CoreTool = {
  spec: {
    name: 'broken_links', title: 'Liens cassés', action: 'read', runtimes: [...RUNTIMES],
    description: 'Les liens [[...]] du vault qui ne mènent à aucune note, les plus nombreux d’abord, avec les notes qui les contiennent.',
    inputSchema: schema({ limit: int('Nombre de cibles (1 à 200, 50 par défaut).') }),
  },
  async run(args, ctx) {
    const r = await power(ctx, 'links', 'unresolved', { limit: limitOf(args, 50, 200) })
    const list = Array.isArray(r.items) ? r.items as { target: string; count: number; sources?: string[] }[] : []
    if (!list.length) return ok('Aucun lien cassé.', { data: { items: [] } })
    return ok(`${list.length} lien(s) cassé(s) :\n${list.map(i => `- [[${i.target}]] ×${i.count}${i.sources?.length ? ` (dans ${i.sources.slice(0, 5).join(', ')})` : ''}`).join('\n')}`, { data: { items: list } })
  },
}

const listTags: CoreTool = {
  spec: {
    name: 'list_tags', title: 'Tags', action: 'read', runtimes: [...RUNTIMES],
    description: 'Les tags (#tag) du vault et le nombre de notes de chacun.',
    inputSchema: schema({ prefix: str('Ce tag et ses sous-tags seulement.'), limit: int('Nombre de tags (1 à 500, 200 par défaut).') }),
  },
  async run(args, ctx) {
    const prefix = optString(args, 'prefix', 200)
    const r = await power(ctx, 'tags', 'list', { limit: limitOf(args, 200, 500), ...(prefix ? { prefix } : {}) })
    const list = Array.isArray(r.items) ? r.items as { tag: string; count: number }[] : []
    return ok(list.length ? list.map(t => `#${t.tag} (${t.count})`).join(', ') : 'Aucun tag.', { data: { items: list } })
  },
}

const notesWithTag: CoreTool = {
  spec: {
    name: 'notes_with_tag', title: 'Notes d’un tag', action: 'read', runtimes: [...RUNTIMES],
    description: 'Les notes qui portent ce tag (sous-tags compris).',
    inputSchema: schema({ tag: str('Le tag, sans #.'), limit: int('Nombre de notes (1 à 200, 50 par défaut).') }, ['tag']),
  },
  async run(args, ctx) {
    const tag = reqString(args, 'tag', 200).replace(/^#/, '')
    const r = await power(ctx, 'tags', 'notes', { tag, limit: limitOf(args, 50, 200) })
    const list = items(r.items).filter(i => pathInScope(ctx.scope, i.path))
    return ok(list.length ? `${list.length} note(s) #${tag} :\n${list.map(i => `- ${i.path} (id : ${i.id})`).join('\n')}` : `Aucune note #${tag}.`,
      { data: { items: list }, sources: list.map(source) })
  },
}

const FILTER_OPS = ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'contains', 'startsWith', 'empty', 'notEmpty']

const queryNotes: CoreTool = {
  spec: {
    name: 'query', title: 'Requête sur les propriétés', action: 'read', runtimes: [...RUNTIMES],
    description: 'Cherche des notes (ou les lignes d’une base) par leurs propriétés (frontmatter) : filtres, tri, valeurs. Ex. filters=[{"property":"statut","op":"eq","value":"en cours"}].',
    inputSchema: schema({
      folder: str('Limiter à un dossier.'),
      base: str('Chemin ou id d’une base (.base) : ses lignes plutôt que les notes.'),
      filters: { type: 'array', description: 'Filtres (tous doivent passer).', items: { type: 'object', properties: { property: str('Nom de la propriété.'), op: { type: 'string', enum: FILTER_OPS }, value: str('Valeur comparée.') } } },
      sort: str('Propriété de tri ; « -nom » pour l’ordre décroissant.'),
      text: str('Mots qui doivent apparaître.'),
      limit: int('Nombre de lignes (1 à 100, 25 par défaut).'),
    }),
  },
  async run(args, ctx) {
    const filters = Array.isArray(args.filters) ? args.filters.slice(0, 16) as { property?: unknown; op?: unknown; value?: unknown }[] : []
    const where = filters.map(f => {
      if (typeof f?.property !== 'string' || !f.property) throw new HostError('filters : property manquant.')
      const op = typeof f.op === 'string' && FILTER_OPS.includes(f.op) ? f.op : 'eq'
      return { field: { prop: f.property }, op, ...(f.value !== undefined && op !== 'empty' && op !== 'notEmpty' ? { value: f.value } : {}) }
    })
    let from: Record<string, unknown> = { notes: true, ...(optString(args, 'folder', 1024) ? { folder: optString(args, 'folder', 1024) } : {}) }
    const base = optString(args, 'base', 1024)
    if (base) {
      // Pas readNote : une base n'a pas de texte (vide tant qu'elle n'a pas de ligne).
      const b = await ctx.host.findNote({ path: base }) ?? await ctx.host.findNote({ path: `${base}.base` }) ?? await ctx.host.findNote({ id: base })
      if (!b || !/\.base$/i.test(b.path)) throw new HostError(`Base introuvable : ${base}.`, 'not_found')
      guard(ctx, b.path)
      from = { base: b.id }
    }
    const sortKey = optString(args, 'sort', 200)
    const q: Record<string, unknown> = { from, limit: limitOf(args, 25, 100) }
    if (where.length) q.where = where.length === 1 ? where[0] : { and: where }
    if (sortKey) q.sort = [{ field: { prop: sortKey.replace(/^-/, '') }, dir: sortKey.startsWith('-') ? 'desc' : 'asc' }]
    const text = optString(args, 'text', 500)
    if (text) q.text = text
    const r = await power(ctx, 'query', 'run', q)
    const rows = (Array.isArray(r.rows) ? r.rows : []) as { id: string; path: string; title: string; values: Record<string, unknown> }[]
    const visible = rows.filter(row => !row.path || pathInScope(ctx.scope, row.path))
    const lines = visible.map(row => `- ${row.path || row.title || row.id}${Object.keys(row.values ?? {}).length ? ` — ${Object.entries(row.values).slice(0, 8).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ')}` : ''}`)
    return ok(`${typeof r.total === 'number' ? r.total : visible.length} résultat(s) :\n${lines.join('\n')}`,
      { data: { rows: visible, total: r.total }, sources: visible.filter(row => row.path).map(row => source(row)) })
  },
}

const listComments: CoreTool = {
  spec: {
    name: 'list_comments', title: 'Commentaires', action: 'read', runtimes: [...RUNTIMES],
    description: 'Les commentaires et suggestions de la Révision d’une note, avec leur statut.',
    inputSchema: schema({ ...NOTE_REF }),
  },
  async run(args, ctx) {
    const note = await noteArg(args, ctx)
    const list = await ctx.host.listReview(note.id)
    if (!list.length) return ok(`Aucun commentaire sur ${note.path}.`, { data: { entries: [] } })
    const lines = list.map(e => `- [${e.id}]${e.parentId ? ` (réponse à ${e.parentId})` : ''} ${e.kind}${e.status ? `, ${e.status}` : ''}, ${e.author} : ${e.text}${e.quote ? ` « ${e.quote.slice(0, 200)} »` : ''}`)
    return ok(`Révision de ${note.path} :\n${lines.join('\n')}`, { data: { entries: list }, sources: [source(note)] })
  },
}

// ── Commentaires ───────────────────────────────────────────────────────────

const comment: CoreTool = {
  spec: {
    name: 'comment', title: 'Commenter', action: 'comment', runtimes: [...RUNTIMES],
    description: 'Ouvre un fil de commentaire sur une note, ou sur un passage précis (quote : texte exact de la note).',
    inputSchema: schema({ ...NOTE_REF, text: str('Le commentaire.'), quote: str('Passage visé, recopié à l’identique (facultatif).') }, ['text']),
  },
  async run(args, ctx) {
    const note = await noteArg(args, ctx)
    const text = reqString(args, 'text', 10_000)
    const quote = optString(args, 'quote', 2000)
    let range: { from: number; to: number } | undefined
    if (quote) {
      const at = findOccurrence(note.content, quote)
      if (at < 0) throw new HostError('Passage introuvable dans la note : recopiez-le à l’identique.')
      range = { from: at, to: at + quote.length }
    }
    const id = await ctx.host.comment(note.id, text, ctx.actor, range)
    return ok(`Commentaire ajouté sur ${note.path}.`, { data: { id }, sources: [source(note)] })
  },
}

const reply: CoreTool = {
  spec: {
    name: 'reply', title: 'Répondre', action: 'comment', runtimes: [...RUNTIMES],
    description: 'Répond à un fil de commentaire (id rendu par list_comments).',
    inputSchema: schema({ thread: str('Id du commentaire auquel répondre.'), text: str('La réponse.') }, ['thread', 'text']),
  },
  async run(args, ctx) {
    const id = await ctx.host.reply(reqString(args, 'thread', 200), reqString(args, 'text', 10_000), ctx.actor)
    return ok('Réponse ajoutée.', { data: { id } })
  },
}

// ── Modifier ───────────────────────────────────────────────────────────────

const editNote: CoreTool = {
  spec: {
    name: 'edit_note', title: 'Modifier un passage', action: 'edit', runtimes: [...RUNTIMES],
    description: 'Remplace un passage d’une note. find : texte exact de la note, assez long pour être unique ; replace : le nouveau texte (vide pour supprimer).',
    inputSchema: schema({ ...NOTE_REF, find: str('Passage à remplacer, recopié à l’identique.'), replace: str('Nouveau texte.'), occurrence: int('Quelle occurrence, à partir de 0 (si le passage revient plusieurs fois).'), why: str('Raison courte, montrée à la personne.') }, ['find', 'replace']),
  },
  async run(args, ctx) {
    const note = await noteArg(args, ctx)
    const find = rawString(args, 'find', 20_000)
    const replacement = rawString(args, 'replace', 200_000)
    if (!find) throw new HostError('find est vide.')
    const occurrence = typeof args.occurrence === 'number' ? Math.max(0, Math.floor(args.occurrence)) : 0
    const at = findOccurrence(note.content, find, occurrence)
    if (at < 0) throw new HostError('Passage introuvable dans la note : relisez-la (read_note) et recopiez-le à l’identique.')
    if (args.occurrence === undefined && countOccurrences(note.content, find) > 1) {
      throw new HostError('Ce passage revient plusieurs fois : allongez find, ou donnez occurrence.')
    }
    if (find === replacement) return ok('Rien à changer.')
    if (ctx.mode === 'propose') {
      // Deja propose, accepte ou refuse dans la Revision : on ne repropose pas.
      const prior: WatchReview[] = (await ctx.host.listReview(note.id).catch(() => []))
        .filter(e => e.kind === 'suggestion' && !e.parentId)
        .map(e => ({ kind: 'suggestion', status: (e.status as WatchReview['status']) ?? 'open', quote: e.quote ?? '', ...(e.replacement !== undefined ? { replacement: e.replacement } : {}) }))
      if (alreadyReviewed({ find, replace: replacement, why: '' }, prior)) {
        return ok('Cette correction est déjà dans la Révision (en attente, acceptée ou refusée) : pas de nouvelle proposition.')
      }
    }
    return change(ctx, note, at, at + find.length, replacement, 'passage remplacé', optString(args, 'why', 500) ?? '')
  },
}

const appendNote: CoreTool = {
  spec: {
    name: 'append', title: 'Ajouter à la fin', action: 'edit', runtimes: [...RUNTIMES],
    description: 'Ajoute du texte Markdown à la fin d’une note.',
    inputSchema: schema({ ...NOTE_REF, text: str('Texte à ajouter.'), why: str('Raison courte, montrée à la personne.') }, ['text']),
  },
  async run(args, ctx) {
    const note = await noteArg(args, ctx)
    const raw = rawString(args, 'text', 200_000)
    if (!raw.trim()) throw new HostError('text est vide.')
    const sep = note.content === '' || note.content.endsWith('\n\n') ? '' : note.content.endsWith('\n') ? '\n' : '\n\n'
    const end = note.content.length
    return change(ctx, note, end, end, sep + raw, `${raw.trim().length} caractères ajoutés à la fin`, optString(args, 'why', 500) ?? '')
  },
}

const setProperty: CoreTool = {
  spec: {
    name: 'set_property', title: 'Poser une propriété', action: 'edit', runtimes: [...RUNTIMES],
    description: 'Pose une propriété dans le frontmatter d’une note (statut, date, auteur...). value vide : la retire.',
    inputSchema: schema({ ...NOTE_REF, name: str('Nom de la propriété.'), value: str('Valeur (texte, nombre, date ISO). Vide : retirer.') }, ['name']),
  },
  async run(args, ctx) {
    const note = await noteArg(args, ctx)
    const name = reqString(args, 'name', 100)
    const raw = args.value
    const value = raw === undefined || raw === null || raw === '' ? null : Array.isArray(raw) ? raw : typeof raw === 'number' || typeof raw === 'boolean' ? raw : String(raw)
    const c = setPropertyChange(note.content, name, value)
    if (!c) return ok('Rien à changer.')
    return change(ctx, note, c.from, c.to, c.text, value === null ? `propriété ${name} retirée` : `propriété ${name} = ${JSON.stringify(value)}`, '')
  },
}

// ── Creer, ranger, supprimer ───────────────────────────────────────────────

/**
 * Un dessin Excalidraw ecrit comme une note : un chemin .excalidraw, ou le
 * JSON d'une scene, ou le format .excalidraw.md d'Obsidian. Une IA qui ne
 * connait pas les outils des dessins le tente ; la note serait illisible.
 */
export function excalidrawInNote(path: string, content: string): boolean {
  if (/\.excalidraw(\.md)?$/i.test(path)) return true
  return /"type"\s*:\s*"excalidraw"/.test(content) || /^excalidraw-plugin\s*:/m.test(content)
}

const createNote: CoreTool = {
  spec: {
    name: 'create_note', title: 'Créer une note', action: 'create', runtimes: [...RUNTIMES],
    description: 'Crée une note (Markdown) à ce chemin, avec ce contenu. Les dossiers manquants sont créés. Pas pour un dessin Excalidraw : il a ses outils (drawing_create).',
    inputSchema: schema({ path: str('Chemin de la nouvelle note (ex. Réunions/2026-11-18.md).'), content: str('Contenu Markdown.') }, ['path']),
  },
  async run(args, ctx) {
    const path = notePath(reqString(args, 'path', 1024))
    const content = rawString(args, 'content', 200_000, false)
    if (excalidrawInNote(path, content)) {
      throw new HostError('Un dessin Excalidraw n’est pas une note : créez-le avec drawing_create, puis drawing_add ou drawing_diagram. Si ces outils manquent, le plugin Excalidraw n’est pas actif dans ce vault.', 'invalid')
    }
    guard(ctx, path)
    if (await ctx.host.readNote({ path })) throw new HostError(`Une note existe déjà : ${path}.`, 'conflict')
    const created = await ctx.host.createNote(path, content, ctx.actor)
    return ok(`Note créée : ${created.path} (id : ${created.id}).`, { data: created, sources: [source(created)] })
  },
}

const createFolder: CoreTool = {
  spec: {
    name: 'create_folder', title: 'Créer un dossier', action: 'create', runtimes: [...RUNTIMES],
    description: 'Crée un dossier (vide).',
    inputSchema: schema({ path: str('Chemin du dossier (ex. Projets/2027).') }, ['path']),
  },
  async run(args, ctx) {
    const path = reqString(args, 'path', 1024).replace(/^\/+|\/+$/g, '')
    if (!path || path.split('/').some(s => s === '..' || s === '.')) throw new HostError('Chemin de dossier invalide.')
    guard(ctx, path)
    await ctx.host.createFolder(path, ctx.actor)
    return ok(`Dossier créé : ${path}.`)
  },
}

const moveNote: CoreTool = {
  spec: {
    name: 'move_note', title: 'Déplacer ou renommer', action: 'organize', runtimes: [...RUNTIMES],
    description: 'Déplace ou renomme une note. to : nouveau chemin complet, ou dossier qui finit par « / ».',
    inputSchema: schema({ ...NOTE_REF, to: str('Nouveau chemin (ex. Archives/Plan.md) ou dossier (ex. Archives/).') }, ['to']),
  },
  async run(args, ctx) {
    const note = await noteArg(args, ctx)
    const to = reqString(args, 'to', 1024)
    const target = to.endsWith('/') ? notePath(`${to}${note.path.split('/').pop()}`) : notePath(to)
    guard(ctx, target)
    if (target === note.path) return ok('La note est déjà là.')
    if (await ctx.host.readNote({ path: target })) throw new HostError(`Une note existe déjà : ${target}.`, 'conflict')
    const moved = await ctx.host.moveNote(note.id, target, ctx.actor)
    return ok(`${note.path} → ${moved}.`, { data: { from: note.path, to: moved, folder: folderOf(moved) }, sources: [source({ id: note.id, path: moved })] })
  },
}

const trashNote: CoreTool = {
  spec: {
    name: 'trash_note', title: 'Mettre à la corbeille', action: 'delete', runtimes: [...RUNTIMES],
    description: 'Met une note à la corbeille (elle peut être restaurée).',
    inputSchema: schema({ ...NOTE_REF }),
  },
  async run(args, ctx) {
    const note = await noteArg(args, ctx)
    const at = await ctx.host.trashNote(note.id, ctx.actor)
    return ok(`${note.path} est à la corbeille (${at}).`, { data: { path: at } })
  },
}

// ── Images ─────────────────────────────────────────────────────────────────

/** Extensions des images qu'un agent peut ajouter (celles que l'appli affiche). */
export const AGENT_IMAGE_EXTENSIONS: readonly string[] = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif']

/** Nom de fichier sur pour un lien `![[...]]` (memes regles que l'appli). */
function imageFileName(raw: string | undefined, ext: string): string {
  const clean = (raw ?? '').replace(/[[\]|#^\\/:]+/g, ' ').replace(/\s+/g, ' ').trim()
  const stem = clean.replace(/\.[a-z0-9]{1,8}$/i, '').replace(/^\.+/, '').slice(0, 120).trim() || 'image'
  return `${stem}.${ext}`
}

/**
 * Le serveur a deja telecharge et verifie l'image (ChatGPT la donne en
 * fichier, d'autres IA par une adresse) et rangee sous fileId : l'outil
 * l'inscrit dans le dossier de la note, puis met le lien dans la note.
 * Seul le serveur l'offre : les octets n'arrivent que par lui.
 */
const addImage: CoreTool = {
  spec: {
    name: 'add_image', title: 'Ajouter une image', action: 'edit', runtimes: ['server'],
    description: 'Ajoute une image à une note : elle est rangée dans le dossier de la note et son lien est ajouté à la fin (sauf insert=false).',
    inputSchema: schema({
      ...NOTE_REF,
      fileId: str('Id du fichier, donné par Savoire.'),
      fileName: str('Nom de l’image (ex. Tableau blanc.jpg).'),
      insert: { type: 'boolean', description: 'Ajouter le lien à la fin de la note (oui par défaut).' },
      why: str('Raison courte, montrée à la personne.'),
    }, ['fileId']),
  },
  async run(args, ctx) {
    if (ctx.mode === 'propose') throw new HostError('En mode proposition, un agent ne peut pas ajouter d’image : il faut le droit de modifier en direct, ou « demander ».', 'denied')
    if (!ctx.host.attachFile) throw new HostError('Ajout d’image indisponible ici.', 'unavailable')
    const fileId = reqString(args, 'fileId', 64)
    if (!/^[A-Za-z0-9-]{1,64}$/.test(fileId)) throw new HostError('fileId invalide.')
    const note = await noteArg(args, ctx)
    const rawName = optString(args, 'fileName', 255)
    const given = rawName?.match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toLowerCase()
    const ext = given && AGENT_IMAGE_EXTENSIONS.includes(given) ? given : 'png'
    const name = imageFileName(rawName, ext)
    // Le dossier de la note : « A/Ma note.md » -> « A/Ma note/ ».
    const folder = `${note.path.replace(/\.[a-z0-9]{1,8}$/i, '')}/`
    const dot = name.lastIndexOf('.')
    let path = `${folder}${name}`
    for (let n = 1; await ctx.host.findNote({ path }); n++) path = `${folder}${name.slice(0, dot)} ${n}${name.slice(dot)}`
    guard(ctx, path)
    const file = await ctx.host.attachFile(fileId, path, note.id, ctx.actor)
    if (args.insert === false) return ok(`Image ajoutée : ${file.path}.`, { data: file, sources: [source(note)] })
    const fresh = await ctx.host.readNote({ id: note.id }) ?? note
    const sep = fresh.content === '' || fresh.content.endsWith('\n\n') ? '' : fresh.content.endsWith('\n') ? '\n' : '\n\n'
    const end = fresh.content.length
    await ctx.host.replaceText(fresh.id, end, end, `${sep}![[${file.path}]]\n`, ctx.actor)
    const why = optString(args, 'why', 500)
    await ctx.host.recordEdit(fresh.id, why ? `image ajoutée (${name}) : ${why}` : `image ajoutée (${name})`, ctx.actor)
    return ok(`Image ajoutée : ${file.path}, avec son lien à la fin de ${note.path}.`, { data: file, sources: [source(note)] })
  },
}

/** Tous les outils du socle, dans l'ordre ou l'IA les voit. */
export const CORE_TOOLS: readonly CoreTool[] = [
  search, readNote, listNotes, backlinks, outgoingLinks, brokenLinks, listTags, notesWithTag, queryNotes, listComments,
  comment, reply,
  editNote, appendNote, setProperty,
  createNote, createFolder, moveNote,
  trashNote,
  addImage,
]
