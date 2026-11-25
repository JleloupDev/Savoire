// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Les outils du socle (ADR-033) : ecrits une fois, executes par l'appli comme
// par le pair indexeur, au-dessus d'un AgentToolHost.
//
// Chaque outil ne fait que son travail. Les droits de l'agent (mode, portee)
// sont verifies par la ToolBox AVANT ; il recoit le mode a appliquer
// ('direct' ou 'propose') et une portee a respecter pour chaque note.
import { textFingerprint, type AgentScope, type ToolActor, type ToolInputSchema, type ToolParamSchema, type ToolResult, type ToolSource, type ToolSpec } from '@savoire/plugin-api'
import { ANCHOR_LOST, resolveAnchor } from './anchor'
import { HostError, type AgentToolHost, type HostNote, type HostNoteRef } from './host'
import {
  alignBlocks, diffBlocks, findBlock, findSections, mergeSnapshot, noteSections, parseLines, refBlocks, renderBlocks, renderChanges, showRef, snapshotOf, stripRefLines,
  type NoteSection, type NoteSnapshot, type RefBlock,
} from './noteRefs'
import { MAX_PATCH_OPS, PATCH_OPS, applyTextChanges, blockChange, orderChanges, parsePatchOps, rangeChange, type PatchOp } from './patch'
import { pathInScope } from './policy'
import { sharedReadMemory, type ReadMemory } from './readMemory'
import { countOccurrences, findOccurrence, folderOf, notePath, setPropertyChange, titleOf, type TextChange } from './text'
import { alreadyReviewed, type WatchReview } from './watch'
import { CONTEXT_TOOLS } from './contextTools'

export interface CoreToolContext {
  mode: 'direct' | 'propose'
  actor: ToolActor
  host: AgentToolHost
  scope?: AgentScope
  /** Ce que les agents ont deja lu (versions, memoire). Absent : la memoire du processus. */
  memory?: ReadMemory
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

const memoryOf = (ctx: CoreToolContext): ReadMemory => ctx.memory ?? sharedReadMemory

/** Dit ce que fait l'agent sur la note (presence). Ne fait jamais echouer l'outil. */
function signal(ctx: CoreToolContext, docId: string, state: 'reading' | 'writing' | 'idle', range?: { from: number; to: number }): void {
  try {
    ctx.host.signal?.({ docId, state, ...(range ? { from: range.from, to: range.to } : {}) })
  } catch { /* la presence est un plus */ }
}

/** La plage que couvrent des changements, dans le texte d'apres. */
function writtenRange(changes: readonly TextChange[]): { from: number; to: number } {
  const last = changes[changes.length - 1]!
  const before = changes.slice(0, -1).reduce((n, c) => n + c.text.length - (c.to - c.from), 0)
  return { from: changes[0]!.from, to: last.from + before + last.text.length }
}

/**
 * L'agent vient d'ecrire : la version d'apres est gardee, et sa memoire sait
 * qu'il connait les blocs qu'il a ecrits (on ne les lui signalera pas comme
 * des changements). Rend les blocs d'apres, et ceux qu'il a touches.
 */
function wrote(ctx: CoreToolContext, note: HostNote, changes: readonly TextChange[]): { snapshot: NoteSnapshot; touched: RefBlock[] } {
  const memory = memoryOf(ctx)
  const after = applyTextChanges(note.content, changes)
  const blocks = refBlocks(after)
  const snapshot = snapshotOf(note.id, after, blocks)
  memory.remember(snapshot)
  let view = memory.view(ctx.actor, note.id)?.snapshot
  const touched = new Set<RefBlock>()
  let shift = 0
  for (const c of changes) {
    const from = c.from + shift
    const to = from + c.text.length
    shift += c.text.length - (c.to - c.from)
    let first = blocks.findIndex(b => b.end > from)
    if (first < 0) first = blocks.length
    let last = first - 1
    while (last + 1 < blocks.length && blocks[last + 1]!.from < to) last++
    for (let i = first; i <= last; i++) touched.add(blocks[i]!)
    if (view) view = mergeSnapshot(view, snapshot, first, last)
  }
  if (view) memory.setView(ctx.actor, view, true)
  return { snapshot, touched: [...touched] }
}

/**
 * Ecrit des changements dans la note (mode direct) : une seule ecriture, sauf
 * un long texte, deroule par l'hote (effet de frappe). `expect` : l'hote
 * refuse si le texte n'est plus celui sur lequel les plages ont ete calculees.
 */
async function writeChanges(ctx: CoreToolContext, note: HostNote, changes: readonly TextChange[], expect?: string): Promise<{ snapshot: NoteSnapshot; touched: RefBlock[] }> {
  if (ctx.host.applyChanges) {
    await ctx.host.applyChanges(note.id, changes, ctx.actor, { typing: true, ...(expect ? { expect } : {}) })
  } else {
    // De la fin vers le debut : les positions d'avant restent justes.
    for (let i = changes.length - 1; i >= 0; i--) await ctx.host.replaceText(note.id, changes[i]!.from, changes[i]!.to, changes[i]!.text, ctx.actor)
  }
  // L'agent se montre la ou il vient d'ecrire (positions du texte d'apres).
  // Pas de « idle » : l'agent part de lui-meme peu apres la fin de l'appel.
  signal(ctx, note.id, 'writing', writtenRange(changes))
  return wrote(ctx, note, changes)
}

/** Remplace une plage : directement (avec la trace), ou en suggestion. */
async function change(ctx: CoreToolContext, note: HostNote, from: number, to: number, text: string, what: string, why: string): Promise<ToolResult> {
  if (ctx.mode === 'propose') {
    // Une proposition n'ecrit rien : pas de curseur.
    const id = await ctx.host.suggest(note.id, from, to, text, ctx.actor, why || what)
    return ok(`Proposition déposée dans la Révision de ${note.path} (${what}). Rien ne change tant que la personne ne l'accepte pas.`,
      { data: { suggestionId: id }, sources: [source(note)] })
  }
  await writeChanges(ctx, note, [{ from, to, text }])
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

const lineCount = (text: string): number => {
  let n = 1
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n++
  return n
}

const linesOf = (blocks: readonly RefBlock[], first: number, last: number): string => {
  const a = blocks[first]!.line
  const b = blocks[last]!.lastLine
  return a === b ? `ligne ${a}` : `lignes ${a}-${b}`
}

/** Le plan d'une note : un titre par ligne, avec ses lignes et sa reference. */
function outlineText(sections: readonly NoteSection[], blocks: readonly RefBlock[], max = 200): string {
  const base = Math.min(...sections.map(s => s.level))
  const lines = sections.slice(0, max).map(s => `${'  '.repeat(Math.min(5, s.level - base))}- ${s.title || '(sans titre)'} (${linesOf(blocks, s.first, s.last)}) ${showRef(blocks[s.first]!.ref)}`)
  if (sections.length > max) lines.push(`… et ${sections.length - max} autre(s) titre(s).`)
  return lines.join('\n')
}

const SINCE_LAST = /^(last|dernier|derni[eè]re)$/i

const readNote: CoreTool = {
  spec: {
    name: 'read_note', title: 'Lire une note', action: 'read', runtimes: [...RUNTIMES],
    description: 'Rend le texte d’une note en Markdown (ou le texte d’un fichier), par son chemin ou son id. Chaque bloc est précédé de sa référence ‹…›, à donner à patch_note pour écrire. Pour ne pas tout relire : section (un titre), lines (des lignes), outline (le plan seul), ou since (seulement ce qui a changé depuis une lecture).',
    inputSchema: schema({
      ...NOTE_REF,
      section: str('Ne lire qu’une section : son titre, ou un chemin « Titre > Sous-titre ».'),
      lines: str('Ne lire que ces lignes (ex. 10-40).'),
      since: str('Jeton de version d’une lecture précédente (ligne « Version »), ou « last » pour votre dernière lecture : ne rend que les blocs ajoutés, modifiés ou supprimés depuis.'),
      outline: { type: 'boolean', description: 'Rendre seulement le plan : titres, lignes et références.' },
    }),
  },
  async run(args, ctx) {
    const note = await noteArg(args, ctx)
    const tail = note.truncated ? '\n\n[Texte tronqué : note trop longue.]' : ''
    const head = `# ${note.path} (id : ${note.id})`
    const base = { id: note.id, path: note.path, length: note.content.length }
    const section = optString(args, 'section', 500)
    const rawLines = typeof args.lines === 'number' ? String(args.lines) : optString(args, 'lines', 40)
    const lines = rawLines ? parseLines(rawLines) : null
    if (rawLines && !lines) throw new HostError('lines : une plage de lignes, par exemple 10-40.')
    const since = optString(args, 'since', 60)
    const outline = args.outline === true || args.outline === 'true'
    const total = lineCount(note.content)

    // Un fichier (PDF, tableur...) : son texte brut, sans blocs ni versions.
    if (!/\.md$/i.test(note.path)) {
      if (section || since || outline) throw new HostError('section, since et outline ne valent que pour une note Markdown.')
      signal(ctx, note.id, 'reading', { from: 0, to: note.content.length })
      if (!lines) return ok(`${head}\n\n${note.content}${tail}`, { data: base, sources: [source(note)] })
      if (lines.from > total) throw new HostError(`Ce texte a ${total} ligne(s).`)
      const to = Math.min(total, lines.to)
      return ok(`${head}\nLignes ${lines.from}-${to} sur ${total}.\n\n${note.content.split('\n').slice(lines.from - 1, to).join('\n')}${to === total ? tail : ''}`, { data: base, sources: [source(note)] })
    }

    const memory = memoryOf(ctx)
    const blocks = refBlocks(note.content)
    const snap = snapshotOf(note.id, note.content, blocks)
    memory.remember(snap)
    const data = { ...base, version: snap.token }

    // La partie demandee : une section, des lignes, ou tout.
    let first = 0
    let last = blocks.length - 1
    const about: string[] = []
    const remarks: string[] = []
    if (section) {
      const all = noteSections(blocks)
      const hits = findSections(all, section)
      if (!hits.length) {
        throw new HostError(`Section introuvable : « ${section} ». ${all.length ? `Sections de cette note :\n${outlineText(all, blocks, 60)}` : 'Cette note n’a pas de titre.'}`, 'not_found')
      }
      const s = hits[0]!
      first = s.first
      last = s.last
      about.push(`section « ${s.path.join(' > ')} »`)
      if (hits.length > 1) {
        remarks.push(`${hits.length} sections portent ce titre ; voici la première. Les autres : ${hits.slice(1, 6).map(h => `« ${h.path.join(' > ')} » (ligne ${blocks[h.first]!.line})`).join(', ')}. Précisez par un chemin, ou par lines.`)
      }
    }
    if (lines) {
      let a = first
      while (a <= last && blocks[a]!.lastLine < lines.from) a++
      let b = last
      while (b >= a && blocks[b]!.line > lines.to) b--
      if (a > b) throw new HostError(`Rien sur ces lignes${section ? ' dans cette section' : ''} : la note a ${total} ligne(s).`)
      first = a
      last = b
    }
    const partial = !!(section || lines)
    if (partial) about.push(`${linesOf(blocks, first, last)} sur ${total}`)
    const view = memory.view(ctx.actor, note.id)
    /** L'agent recoit cette partie : sa memoire la connait. */
    const seen = (from?: NoteSnapshot): void => {
      const prior = view?.snapshot ?? from
      if (!partial || !prior) memory.setView(ctx.actor, snap)
      else memory.setView(ctx.actor, mergeSnapshot(prior, snap, first, last), true)
    }

    signal(ctx, note.id, 'reading', partial && blocks.length ? { from: blocks[first]!.from, to: blocks[last]!.end } : { from: 0, to: note.content.length })
    {
      if (outline) {
        const all = noteSections(blocks).filter(s => s.first >= first && s.first <= last)
        return ok(`${head}\nVersion : ${snap.token} · ${blocks.length} bloc(s), ${total} ligne(s).\n\n${all.length ? `Plan :\n${outlineText(all, blocks)}` : 'Aucun titre.'}`,
          { data, sources: [source(note)] })
      }
      let miss = ''
      if (since) {
        const own = SINCE_LAST.test(since)
        const old = own ? view?.snapshot : memory.version(note.id, since)
        if (old) {
          const changes = diffBlocks(old, blocks).filter(c => !partial || (c.index >= first && c.index <= last + (c.kind === 'removed' ? 1 : 0)))
          seen(old)
          const from = own ? 'votre dernière lecture' : old.token
          const scope = about.length ? ` (${about.join(', ')})` : ''
          if (!changes.length) return ok(`${head}\nVersion : ${snap.token}. Rien n’a changé depuis ${from}${scope}.`, { data: { ...data, changes: 0 }, sources: [source(note)] })
          const count = (k: string): number => changes.filter(c => c.kind === k).length
          return ok(`${head}\nVersion : ${snap.token}. Depuis ${from}${scope} : ${count('changed')} bloc(s) modifié(s), ${count('added')} ajouté(s), ${count('removed')} supprimé(s).\n\n${renderChanges(changes, blocks)}`,
            { data: { ...data, changes: changes.length }, sources: [source(note)] })
        }
        miss = own
          ? 'Aucune lecture précédente en mémoire : voici le texte.'
          : `Version ${since} oubliée ou inconnue : voici le texte, pas seulement les changements.`
      }
      seen()
      const meta = [`Version : ${snap.token} · ${partial ? about.join(', ') : `${blocks.length} bloc(s), ${total} ligne(s)`}. Référence de chaque bloc entre ‹ ›.`, ...remarks, ...(miss ? [miss] : [])]
      const body = blocks.length ? renderBlocks(note.content, blocks, first, last) : note.content
      return ok(`${head}\n${meta.join('\n')}\n\n${body}${!partial || last === blocks.length - 1 ? tail : ''}`, { data, sources: [source(note)] })
    }
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
    let find = rawString(args, 'find', 20_000)
    const replacement = rawString(args, 'replace', 200_000)
    if (!find) throw new HostError('find est vide.')
    const occurrence = typeof args.occurrence === 'number' ? Math.max(0, Math.floor(args.occurrence)) : 0
    // Un passage recopie d'une lecture, avec ses lignes de reference ‹...› : on les retire.
    if (findOccurrence(note.content, find, occurrence) < 0 && stripRefLines(find).trim()) find = stripRefLines(find)
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

// ── Retoucher (patch_note) ─────────────────────────────────────────────────

const ANCHOR_SCHEMA: ToolParamSchema = {
  type: 'object',
  description: 'Ou : une ancre donnée par l’éditeur (curseur ou sélection de la personne), rendue telle quelle.',
  properties: { docId: str('Id de la note.'), start: str('Position de début.'), end: str('Position de fin.'), quote: str('Texte sélectionné.'), prefix: str('Texte juste avant.'), suffix: str('Texte juste après.') },
}

/**
 * Une reference qui ne mene plus a rien : ou est ce bloc aujourd'hui, d'apres
 * les versions gardees ? `same` : il est la, inchange (seul son rang a
 * bouge) ; `now` : les blocs a sa place (aucun : supprime). Null : inconnu.
 */
function whereNow(memory: ReadMemory, actor: ToolActor, docId: string, blocks: readonly RefBlock[], ref: string): { same?: RefBlock; now?: RefBlock[] } | null {
  for (const old of memory.versionsOf(actor, docId)) {
    const hit = findBlock(old.blocks, ref)
    if (!hit) continue
    const at = old.blocks.indexOf(hit.block)
    let j0 = 0
    for (const [i1, j1] of alignBlocks(old.blocks, blocks)) {
      if (at === i1 && blocks[j1]) return { same: blocks[j1] }
      if (at < i1) {
        const byId = hit.block.blockId ? blocks.find(b => b.blockId === hit.block.blockId) : undefined
        return { now: byId ? [byId] : blocks.slice(j0, j1) }
      }
      j0 = j1 + 1
    }
  }
  return null
}

/** Les changements que demandent ces operations sur la note d'aujourd'hui, ou le refus a rendre a l'IA. */
async function planPatch(ctx: CoreToolContext, note: HostNote, ops: readonly PatchOp[]): Promise<{ changes: TextChange[] } | { refused: string }> {
  const memory = memoryOf(ctx)
  const blocks = refBlocks(note.content)
  const view = memory.view(ctx.actor, note.id)
  const changes: TextChange[] = []
  const refused: string[] = []
  /** On rend a l'agent le texte de ces blocs : il les connait, une reprise par « ^id » passera. */
  const shown = (list: readonly RefBlock[]): string => {
    for (const b of list) if (b.blockId) memory.acknowledge(ctx.actor, note.id, b.blockId, b.hash)
    return list.map(b => `${showRef(b.ref)}\n${b.text}`).join('\n\n')
  }
  for (const [i, op] of ops.entries()) {
    const n = `Opération ${i + 1}`
    if (op.at) {
      const relative = ctx.host.resolveRelative && op.at.start
        ? await ctx.host.resolveRelative(note.id, op.at.start, op.at.end).catch(() => null)
        : null
      const range = resolveAnchor(note.content, op.at, relative)
      if (!range) throw new HostError(`${n} : ${ANCHOR_LOST}. Le passage visé n’est plus dans la note : relisez-la, ou visez un bloc par sa référence.`, 'not_found')
      changes.push(rangeChange(range, op))
      continue
    }
    let hit = findBlock(blocks, op.ref!)
    if (!hit) {
      const where = whereNow(memory, ctx.actor, note.id, blocks, op.ref!)
      if (where?.same) hit = { block: where.same, byHash: true }
      else if (where?.now?.length) {
        const more = where.now.length > 3 ? `\n… et ${where.now.length - 3} autre(s) bloc(s) : relisez la section.` : ''
        refused.push(`${n} : le bloc ${showRef(op.ref!)} n’existe plus tel quel (modifié ou remplacé). À sa place aujourd’hui :\n${shown(where.now.slice(0, 3))}${more}`)
      } else if (where) refused.push(`${n} : le bloc ${showRef(op.ref!)} a été supprimé.`)
      else refused.push(`${n} : bloc ${showRef(op.ref!)} introuvable. Il a changé, ou la référence est fausse : relisez la section (read_note avec section, ou since: "last").`)
      if (!hit) continue
    }
    const block = hit.block
    // Vise par son « ^id » : a-t-il change depuis que l'agent l'a lu ? (Inserer a cote ne lit pas son texte.)
    const reads = op.find !== undefined || op.op === 'replace' || op.op === 'delete'
    if (!hit.byHash && reads && view && block.blockId) {
      const known = view.known.get(block.blockId) ?? view.snapshot.blocks.find(b => b.blockId === block.blockId)?.hash
      if (known && known !== block.hash) {
        refused.push(`${n} : le bloc ${showRef(block.ref)} a changé depuis votre lecture. Son texte aujourd’hui :\n${shown([block])}`)
        continue
      }
    }
    try {
      changes.push(blockChange(note.content, blocks, block, op))
    } catch (err) {
      // Le message rend le texte du bloc : l'agent le connait maintenant.
      if (block.blockId) memory.acknowledge(ctx.actor, note.id, block.blockId, block.hash)
      throw err instanceof HostError ? new HostError(`${n} : ${err.message}`, err.code) : err
    }
  }
  if (refused.length) {
    return { refused: `Rien n’a été écrit : la note a changé depuis votre lecture.\n\n${refused.join('\n\n')}\n\nRefaites l’appel avec les références et les textes d’aujourd’hui.` }
  }
  return { changes: orderChanges(note.content, changes) }
}

const patchNote: CoreTool = {
  spec: {
    name: 'patch_note', title: 'Retoucher une note', action: 'edit', runtimes: [...RUNTIMES],
    description: 'Modifie une note par retouches, sans la réécrire. Chaque opération vise un bloc par sa référence (ref : le texte entre ‹ › rendu par read_note), un passage dans ce bloc (ref + find), ou une ancre de l’éditeur (at). op : insert_before, insert_after, replace, delete. Si un bloc a changé depuis votre lecture, rien n’est écrit et son texte d’aujourd’hui est rendu : refaites l’appel.',
    inputSchema: schema({
      ...NOTE_REF,
      ops: {
        type: 'array',
        description: `Les retouches (1 à ${MAX_PATCH_OPS}), toutes appliquées ensemble.`,
        items: {
          type: 'object',
          properties: {
            op: { type: 'string', enum: [...PATCH_OPS], description: 'insert_before ou insert_after : ajouter avant ou après ; replace : remplacer ; delete : supprimer.' },
            ref: str('Référence du bloc visé (ex. a1b2c3d4, ou ^id).'),
            find: str('Avec ref : un court passage de ce bloc, recopié à l’identique. L’opération porte alors sur ce passage, pas sur le bloc entier. Ex. ajouter une ligne à une liste : find = sa dernière ligne, op = insert_after, text = retour à la ligne puis la nouvelle ligne.'),
            at: ANCHOR_SCHEMA,
            text: str('Le texte Markdown à insérer, ou qui remplace. Inutile pour delete.'),
          },
        },
      },
      why: str('Raison courte, montrée à la personne.'),
    }, ['ops']),
  },
  async run(args, ctx) {
    const ops = parsePatchOps(args.ops)
    // La note : par path ou id ; sinon celle de l'ancre.
    const named = optString(args, 'id', 200) || optString(args, 'path', 1024)
    const anchored = ops.find(o => o.at)?.at?.docId
    const note = await noteArg(!named && anchored ? { id: anchored } : args, ctx)
    if (ops.some(o => o.at && o.at.docId !== note.id)) throw new HostError('at : cette ancre vient d’une autre note.')
    const why = optString(args, 'why', 500) ?? ''
    for (let attempt = 0; ; attempt++) {
      const current = attempt ? await noteArg({ id: note.id }, ctx) : note
      const plan = await planPatch(ctx, current, ops)
      if ('refused' in plan) return { text: plan.refused, isError: true, sources: [source(current)] }
      const { changes } = plan
      if (!changes.length) return ok('Rien à changer.')
      const what = changes.length === 1 ? '1 retouche' : `${changes.length} retouches`

      if (ctx.mode === 'propose') {
        // Comme edit_note : une suggestion par retouche, jamais deux fois la meme.
        const prior: WatchReview[] = (await ctx.host.listReview(current.id).catch(() => []))
          .filter(e => e.kind === 'suggestion' && !e.parentId)
          .map(e => ({ kind: 'suggestion', status: (e.status as WatchReview['status']) ?? 'open', quote: e.quote ?? '', ...(e.replacement !== undefined ? { replacement: e.replacement } : {}) }))
        const ids: string[] = []
        for (const c of changes) {
          const quote = current.content.slice(c.from, c.to)
          if (quote && alreadyReviewed({ find: quote, replace: c.text, why: '' }, prior)) continue
          ids.push(await ctx.host.suggest(current.id, c.from, c.to, c.text, ctx.actor, why || (!quote ? 'texte ajouté' : c.text ? 'passage remplacé' : 'passage supprimé')))
        }
        if (!ids.length) return ok('Ces retouches sont déjà dans la Révision (en attente, acceptées ou refusées) : pas de nouvelle proposition.')
        return ok(`${ids.length} proposition(s) déposée(s) dans la Révision de ${current.path}. Rien ne change tant que la personne ne les accepte pas.`,
          { data: { suggestionIds: ids }, sources: [source(current)] })
      }

      try {
        const done = await writeChanges(ctx, current, changes, current.truncated ? undefined : textFingerprint(current.content))
        await ctx.host.recordEdit(current.id, why ? `${what} : ${why}` : what, ctx.actor)
        const written = done.touched.slice(0, 20).map(b => `${showRef(b.ref)} ${linesOf([b], 0, 0)}`)
        return ok(`${current.path} modifiée (${what}). Version : ${done.snapshot.token}.${written.length ? `\nBlocs écrits :\n${written.join('\n')}` : ''}`,
          { data: { version: done.snapshot.token, blocks: done.touched.map(b => b.ref) }, sources: [source(current)] })
      } catch (err) {
        // La note a bouge entre la lecture et l'ecriture (rien n'est parti) : on recalcule une fois.
        if (attempt === 0 && ctx.host.applyChanges && err instanceof HostError && err.code === 'conflict') continue
        throw err
      }
    }
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
    await writeChanges(ctx, fresh, [{ from: end, to: end, text: `${sep}![[${file.path}]]\n` }])
    const why = optString(args, 'why', 500)
    await ctx.host.recordEdit(fresh.id, why ? `image ajoutée (${name}) : ${why}` : `image ajoutée (${name})`, ctx.actor)
    return ok(`Image ajoutée : ${file.path}, avec son lien à la fin de ${note.path}.`, { data: file, sources: [source(note)] })
  },
}

/** Tous les outils du socle, dans l'ordre ou l'IA les voit. */
export const CORE_TOOLS: readonly CoreTool[] = [
  search, readNote, listNotes, backlinks, outgoingLinks, brokenLinks, listTags, notesWithTag, queryNotes, listComments,
  comment, reply,
  editNote, patchNote, appendNote, setProperty,
  createNote, createFolder, moveNote,
  trashNote,
  addImage,
  // Contexte de l'editeur (appli) : ou travaille la personne, ses epingles.
  ...CONTEXT_TOOLS,
]
