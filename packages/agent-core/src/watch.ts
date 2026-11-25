// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Veille d'un agent sur la note ouverte : comme quelqu'un qui lit par-dessus
// l'epaule. La note est decoupee en blocs (plugin-api/noteBlocks.ts) ; chaque
// bloc a une empreinte. L'agent relit un bloc a la fois, celui qu'il n'a pas
// encore vu dans cette version, avec le reste de la note comme contexte.
//
//  - Memoire : les empreintes deja relues (et leur resume d'une ligne), les
//    remarques deja faites. Un bloc relu ne l'est plus tant qu'il ne change
//    pas. L'hote la garde (WatchMemoryStore).
//  - File : ce qui est a l'ecran d'abord, puis dans l'ordre de la note ;
//    une ou deux analyses a la fois. Un bloc modifie pendant son analyse :
//    l'analyse est annulee, il sera relu dans sa nouvelle version.
//  - Gros collage : au-dela de `askAbove` blocs a relire d'un coup, on
//    demande d'abord (askLarge) ; refuse : ces blocs comptent comme vus.
//  - Contexte : la note entiere si elle est courte (le debut de la demande ne
//    change pas d'un bloc a l'autre : le fournisseur le garde en cache) ;
//    sinon son plan (titres, une ligne par bloc), les blocs voisins en entier.
//  - Reponse rangee : fautes (en suggestions), un conseil ou rien, un resume.
//  - Revisions de la note (reviews) : l'IA voit les suggestions et
//    commentaires deja faits, en attente, acceptes ou REFUSES ; une faute deja
//    proposee ou refusee n'est jamais reproposee (filtre ici, pas seulement
//    demande a l'IA). Un conseil ecarte non plus.
//  - Contexte donne par la personne (addContext) : garde avec la note,
//    joint a chaque analyse, sans arreter la veille.
//  - Le paragraphe ou la personne tape (typing) n'est pas relu tant qu'elle
//    y ecrit : il attend qu'elle ait fini (meme regle que les outils
//    d'ecriture, typingGuard.ts).
//
// Sans DOM, sans reseau : l'hote donne l'IA (chat), dessine l'etat (onState)
// et range les trouvailles (onFinding).
import { PROSE_BLOCK_KINDS, type AIChatRequest, type AIChatResponse, type AgentDefinition, type AIMessage, type NoteBlock } from '@savoire/plugin-api'

export const WATCH_ASK_ABOVE = 30
/** Une note plus courte est donnee en entier comme contexte. */
export const WATCH_FULL_NOTE_CHARS = 12_000
const NEIGHBORS = 2
const MAX_REMARKS = 8
const MAX_DISMISSED = 20
const MAX_CONTEXT = 10
const MAX_REVIEWS_IN_PROMPT = 40
const MAX_FAULTS = 10
/** Erreurs passageres de suite avant d'arreter la veille. */
const MAX_FAILURES = 4
const RETRY_MS = 4000

/**
 * Une erreur qui ne passera pas en reessayant : pas d'IA, cle refusee,
 * modele introuvable. Les autres (reseau, 429, 5xx, reponse illisible) sont
 * passageres.
 */
export function isFatalWatchError(err: unknown): boolean {
  const e = err as { fatal?: boolean; status?: number; message?: string } | null
  if (!e) return false
  if (e.fatal === true || /^Aucune IA configurée/.test(e.message ?? '')) return true
  return e.status === 401 || e.status === 403 || e.status === 404
}
/** Un bloc plus court n'est pas relu (« Oui. », une puce vide). */
const MIN_BLOCK_CHARS = 3

export interface WatchNote {
  vaultId: string
  docId: string
  path: string
  text: string
  blocks: NoteBlock[]
}

export interface WatchFault {
  find: string
  replace: string
  why: string
}

export interface WatchReply {
  faults: WatchFault[]
  advice: string | null
  summary: string
}

export interface WatchMemory {
  /** Empreinte relue -> son resume d'une ligne (vide si inconnu). */
  seen: Map<string, string>
  /** Les dernieres remarques faites sur la note (pour ne pas se repeter). */
  remarks: string[]
  /** Conseils ecartes par la personne (« Ignorer ») : a ne pas redonner. */
  dismissed?: string[]
  /** Contexte donne par la personne pour cette note (« c'est un courrier formel »...). */
  context?: string[]
}

/** Une revision de la note (Revision), telle que la veille la voit. */
export interface WatchReview {
  kind: 'suggestion' | 'comment'
  status: 'open' | 'accepted' | 'rejected' | 'resolved'
  /** Passage vise. */
  quote: string
  /** Suggestion : le texte propose. */
  replacement?: string
  /** Commentaire : son texte ; suggestion : sa raison. */
  text?: string
  /** Fait par cet agent (et non par une personne ou un autre agent). */
  mine?: boolean
}

export interface WatchMemoryStore {
  load(agentId: string, vaultId: string, docId: string): WatchMemory
  save(agentId: string, vaultId: string, docId: string, memory: WatchMemory): void
}

export type WatchBlockState = 'pending' | 'reading'

export interface WatchStatus {
  docId: string | null
  /** Empreinte -> etat (les blocs relus n'y sont pas). */
  blocks: Map<string, WatchBlockState>
  /** Blocs a relire en attente d'accord (gros collage), 0 sinon. */
  asking: number
  reading: number
  pending: number
  /** Arret sur erreur (IA absente, cle refusee, budget atteint, erreurs repetees). */
  error?: string
  /** Erreur passagere : la veille continue et reessaie. */
  warning?: string
}

export interface BlockWatcherDeps {
  agent: AgentDefinition
  chat(request: AIChatRequest): Promise<AIChatResponse>
  memory: WatchMemoryStore
  /** Peut-on encore depenser ? Une raison : non (budget du jour atteint...). */
  canSpend?(): string | null
  /** Tokens consommes par une analyse. */
  onUsage?(usage: { inputTokens: number; outputTokens: number }): void
  /** Une analyse a abouti, sur un bloc encore present dans la note. */
  onFinding(note: WatchNote, block: NoteBlock, reply: WatchReply): void
  onState?(status: WatchStatus): void
  /** Gros collage : demander avant de relire `count` blocs. Rend l'accord. */
  askLarge?(count: number, estimatedTokens: number): Promise<boolean>
  /** Revisions de la note (suggestions, commentaires, avec leur statut). */
  reviews?(note: WatchNote): WatchReview[]
  /**
   * Le bloc ou la personne tape en ce moment (son empreinte), et dans combien
   * de temps il sera libre. Null : elle ne tape pas. La veille ne relit pas
   * ce bloc avant.
   */
  typing?(note: WatchNote): { blockHash: string; freeInMs: number } | null
}

/** Les blocs que la veille relit. */
export function watchableBlocks(blocks: readonly NoteBlock[]): NoteBlock[] {
  return blocks.filter(b => PROSE_BLOCK_KINDS.has(b.kind) && b.kind !== 'heading' && b.text.trim().length >= MIN_BLOCK_CHARS)
}

/** Ce que l'on demande a l'IA, en plus des consignes de l'agent. */
export const WATCH_PROTOCOL = `Tu relis une note pendant qu'on l'écrit, un bloc à la fois, comme quelqu'un qui lit par-dessus l'épaule.
Réponds en JSON seulement, sans texte autour :
{"fautes":[{"find":"…","replace":"…","why":"…"}],"conseil":null,"resume":"…"}
- fautes : les fautes d'orthographe, de grammaire, de typographie du BLOC À RELIRE seulement. "find" est recopié à l'identique depuis le bloc (quelques mots, unique dans le bloc), "replace" est la correction, "why" dit pourquoi en quelques mots. Liste vide s'il n'y en a pas.
- conseil : une seule remarque vraiment utile sur ce bloc (fond, clarté, structure, lien avec le reste de la note), en une ou deux phrases, en tutoyant. null s'il n'y a rien d'utile à dire : c'est la réponse la plus fréquente.
- resume : le bloc résumé en une ligne (10 à 20 mots), pour le plan de la note.
Ne touche ni au Markdown, ni aux liens [[...]], ni au code. Ne répète pas une remarque déjà faite.
Ne repropose jamais une correction déjà suggérée, acceptée ou refusée (voir les révisions de la note), ni un conseil écarté.`

function clip(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat
}

/** Le plan d'une longue note : titres, et une ligne par bloc (son resume s'il est connu). */
export function noteOutline(note: WatchNote, memory: WatchMemory, around: NoteBlock): string {
  const lines: string[] = []
  for (const b of note.blocks) {
    if (b.kind === 'frontmatter') continue
    const near = Math.abs(b.index - around.index) <= NEIGHBORS
    if (b.index === around.index) { lines.push(`[${b.index}] >>> BLOC À RELIRE <<<`); continue }
    if (b.kind === 'heading') { lines.push(b.text.trim()); continue }
    if (near) { lines.push(`[${b.index}] ${b.text}`); continue }
    const summary = memory.seen.get(b.hash)
    lines.push(`[${b.index}] ${summary ? `(résumé) ${summary}` : clip(b.text, 120)}`)
  }
  return lines.join('\n')
}

const STATUS_LABEL: Record<WatchReview['status'], string> = { open: 'en attente', accepted: 'acceptée', rejected: 'REFUSÉE', resolved: 'résolue' }

/** Les revisions utiles pour ce bloc d'abord (celles qui citent son texte), puis les plus recentes. */
function reviewLines(reviews: readonly WatchReview[], block: NoteBlock): string[] {
  const near = (r: WatchReview) => !!r.quote && (block.text.includes(r.quote) || r.quote.includes(block.text))
  const sorted = [...reviews.filter(near), ...reviews.filter(r => !near(r)).reverse()].slice(0, MAX_REVIEWS_IN_PROMPT)
  return sorted.map(r => {
    const who = r.mine ? ' (par toi)' : ''
    if (r.kind === 'suggestion') {
      return `- suggestion ${STATUS_LABEL[r.status]}${who} : « ${clip(r.quote, 120)} » → « ${clip(r.replacement ?? '', 120)} »${r.text ? ` (${clip(r.text, 80)})` : ''}`
    }
    const status = r.status === 'open' ? 'ouvert' : r.status === 'resolved' ? 'résolu' : r.status === 'rejected' ? 'REJETÉ' : 'accepté'
    return `- commentaire ${status}${who}${r.quote ? ` sur « ${clip(r.quote, 80)} »` : ''} : ${clip(r.text ?? '', 160)}`
  })
}

/** Les messages d'une analyse : consignes, note (ou son plan), revisions, remarques deja faites, bloc. */
export function watchMessages(agent: AgentDefinition, note: WatchNote, block: NoteBlock, memory: WatchMemory, reviews: readonly WatchReview[] = []): AIMessage[] {
  const personContext = memory.context?.length
    ? `Contexte donné par la personne pour cette note :\n${memory.context.map(c => `- ${c}`).join('\n')}`
    : ''
  const system = [agent.instructions.trim(), WATCH_PROTOCOL, personContext].filter(Boolean).join('\n\n')
  const full = note.text.length <= WATCH_FULL_NOTE_CHARS
  const context = full
    ? `Note « ${note.path} », en entier :\n<<<\n${note.text}\n>>>`
    : `Note « ${note.path} », trop longue pour être donnée en entier. Son plan, avec les blocs voisins en entier :\n<<<\n${noteOutline(note, memory, block)}\n>>>`
  const lines = reviewLines(reviews, block)
  const revs = lines.length ? `\n\nRévisions de la note (ne pas reproposer ce qui est en attente, accepté ou refusé) :\n${lines.join('\n')}` : ''
  const remarks = memory.remarks.length
    ? `\n\nRemarques déjà faites sur cette note (ne pas les répéter) :\n${memory.remarks.map(r => `- ${r}`).join('\n')}`
    : ''
  const dismissed = memory.dismissed?.length
    ? `\n\nConseils écartés par la personne (ne plus les donner) :\n${memory.dismissed.map(r => `- ${r}`).join('\n')}`
    : ''
  const where = block.section ? `, section « ${block.section} »` : ''
  return [
    { role: 'system', content: system },
    // La note d'abord : ce debut ne change pas d'un bloc a l'autre (cache du fournisseur).
    { role: 'user', content: `${context}${revs}${remarks}${dismissed}\n\nBloc à relire (n° ${block.index}${where}) :\n<<<\n${block.text}\n>>>` },
  ]
}

const fold = (t: string): string => t.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * Une faute deja traitee dans la Revision : meme correction deja proposee
 * (quel que soit son statut), ou passage dont la personne a refuse une
 * correction.
 */
export function alreadyReviewed(fault: WatchFault, reviews: readonly WatchReview[]): boolean {
  const find = fold(fault.find)
  const replace = fold(fault.replace)
  return reviews.some(r => {
    if (r.kind !== 'suggestion') return false
    const quote = fold(r.quote)
    const repl = fold(r.replacement ?? '')
    if (!quote) return false
    if (quote === find && repl === replace) return true
    if (replace && quote.includes(find) && repl.includes(replace) && quote !== repl) return true
    return r.status === 'rejected' && (quote.includes(find) || find.includes(quote))
  })
}

/** Un conseil deja ecarte (ou deja donne) : meme texte, a la casse et aux espaces pres. */
function sameAdvice(advice: string, list: readonly string[] | undefined): boolean {
  const a = fold(advice)
  return !!list?.some(x => { const b = fold(x).replace(/…$/, ''); return b && (a === b || a.startsWith(b)) })
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')

/** Lit la reponse de l'IA ; tolere du texte autour du JSON. Null : illisible. */
export function parseWatchReply(text: string, blockText: string): WatchReply | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let v: Record<string, unknown>
  try { v = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown> } catch { return null }
  if (!v || typeof v !== 'object') return null
  const rawFaults = Array.isArray(v.fautes) ? v.fautes : Array.isArray(v.faults) ? v.faults : []
  const faults: WatchFault[] = []
  for (const f of rawFaults as Record<string, unknown>[]) {
    if (faults.length >= MAX_FAULTS) break
    const find = typeof f?.find === 'string' ? f.find.slice(0, 300) : ''
    const replace = typeof f?.replace === 'string' ? f.replace.slice(0, 600) : null
    // Une faute dont le texte n'est pas dans le bloc, ou qui ne change rien, ne compte pas.
    if (!find || replace === null || replace === find || !blockText.includes(find)) continue
    faults.push({ find, replace, why: str(f.why, 200) })
  }
  const rawAdvice = v.conseil ?? v.advice
  const advice = str(rawAdvice, 600)
  return { faults, advice: advice && advice.toLowerCase() !== 'null' ? advice : null, summary: str(v.resume ?? v.summary, 240) }
}

/** Estimation grossiere : 4 caracteres par token. */
function estimate(note: WatchNote, count: number): number {
  const context = Math.min(note.text.length, WATCH_FULL_NOTE_CHARS)
  return Math.round(((context + 1500) / 4 + 150) * count)
}

interface Job {
  hash: string
  ac: AbortController
}

export class BlockWatcher {
  private note: WatchNote | null = null
  private memory: WatchMemory = { seen: new Map(), remarks: [] }
  private readonly running = new Map<string, Job>()
  private queue: NoteBlock[] = []
  /** Gros collage accepte (ou refuse) pour cette note : on ne redemande pas pour les memes blocs. */
  private asking: { count: number } | null = null
  private stopped = false
  private error: string | undefined
  private warning: string | undefined
  private failures = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  /** On reviendra au bloc ou la personne tape, quand elle aura fini. */
  private typingTimer: ReturnType<typeof setTimeout> | null = null
  private visible: { from: number; to: number } = { from: 0, to: Number.MAX_SAFE_INTEGER }

  constructor(private readonly d: BlockWatcherDeps) {}

  get agentId(): string {
    return this.d.agent.id
  }

  private get concurrency(): number {
    const c = this.d.agent.watch?.concurrency ?? 1
    return c >= 2 ? 2 : 1
  }

  private get askAbove(): number {
    const n = this.d.agent.watch?.askAbove
    return typeof n === 'number' && n > 0 ? n : WATCH_ASK_ABOVE
  }

  /**
   * La note a change (ou une autre note est ouverte). `visible` : le passage
   * a l'ecran, relu en premier.
   */
  update(note: WatchNote | null, visible?: { from: number; to: number }): void {
    if (this.stopped) return
    if (visible) this.visible = visible
    const switched = !note || !this.note || note.docId !== this.note.docId || note.vaultId !== this.note.vaultId
    if (switched) {
      this.cancelAll()
      this.queue = []
      this.asking = null
      this.askedFor = new Set()
      if (note) this.memory = this.d.memory.load(this.d.agent.id, note.vaultId, note.docId)
    }
    this.note = note
    if (!note) { this.emit(); return }
    const present = new Set(note.blocks.map(b => b.hash))
    // Un bloc modifie pendant son analyse : on l'abandonne.
    for (const [hash, job] of this.running) if (!present.has(hash)) { job.ac.abort(); this.running.delete(hash) }
    const todo = watchableBlocks(note.blocks).filter(b => !this.memory.seen.has(b.hash) && !this.running.has(b.hash))
    this.queue = this.order(todo)
    this.pump()
  }

  /** Le passage a l'ecran a bouge : l'ordre de la file suit. */
  setVisible(visible: { from: number; to: number }): void {
    this.visible = visible
    this.queue = this.order(this.queue)
  }

  /** Arrete la veille (annule ce qui est en cours). */
  stop(): void {
    this.stopped = true
    this.cancelAll()
    this.queue = []
    this.emit()
  }

  /** Oublie ce que l'agent a lu de la note active : il relira tout. */
  forget(): void {
    const note = this.note
    if (!note) return
    this.cancelAll()
    // Ce qui est oublie : ce qu'il a lu. Le contexte et les conseils ecartes restent.
    this.memory = { seen: new Map(), remarks: [], ...(this.memory.dismissed ? { dismissed: this.memory.dismissed } : {}), ...(this.memory.context ? { context: this.memory.context } : {}) }
    this.d.memory.save(this.d.agent.id, note.vaultId, note.docId, this.memory)
    this.asking = null
    this.askedFor = new Set()
    this.update(note)
  }

  /** Le contexte donne par la personne pour la note active. */
  context(): string[] {
    return [...(this.memory.context ?? [])]
  }

  /** Ajoute du contexte pour la note active, sans arreter la veille ; joint aux prochaines analyses. */
  addContext(text: string): void {
    const t = text.trim().slice(0, 1000)
    const note = this.note
    if (!t || !note) return
    this.memory.context = [...(this.memory.context ?? []), t].slice(-MAX_CONTEXT)
    this.d.memory.save(this.d.agent.id, note.vaultId, note.docId, this.memory)
    this.emit()
  }

  removeContext(index: number): void {
    const note = this.note
    if (!note || !this.memory.context?.[index]) return
    this.memory.context = this.memory.context.filter((_, i) => i !== index)
    this.d.memory.save(this.d.agent.id, note.vaultId, note.docId, this.memory)
    this.emit()
  }

  /** La personne ecarte un conseil : il ne sera plus donne sur cette note. */
  dismissAdvice(advice: string): void {
    const note = this.note
    if (!note) return
    this.memory.dismissed = [...(this.memory.dismissed ?? []), clip(advice, 160)].slice(-MAX_DISMISSED)
    this.d.memory.save(this.d.agent.id, note.vaultId, note.docId, this.memory)
  }

  status(): WatchStatus {
    const blocks = new Map<string, WatchBlockState>()
    if (!this.asking) for (const b of this.queue) blocks.set(b.hash, 'pending')
    for (const hash of this.running.keys()) blocks.set(hash, 'reading')
    return {
      docId: this.note?.docId ?? null, blocks,
      asking: this.asking?.count ?? 0,
      reading: this.running.size, pending: this.asking ? 0 : this.queue.length,
      ...(this.error ? { error: this.error } : {}),
      ...(this.warning ? { warning: this.warning } : {}),
    }
  }

  private order(blocks: NoteBlock[]): NoteBlock[] {
    const v = this.visible
    const onScreen = (b: NoteBlock) => b.to >= v.from && b.from <= v.to
    return [...blocks].sort((a, b) => Number(onScreen(b)) - Number(onScreen(a)) || a.index - b.index)
  }

  private async ask(note: WatchNote, count: number): Promise<void> {
    const ok = this.d.askLarge ? await this.d.askLarge(count, estimate(note, count)).catch(() => false) : true
    if (this.stopped || this.note?.docId !== note.docId) return
    if (ok) {
      // Accepte : ces blocs ne redemandent plus ; un nouveau gros collage redemandera.
      for (const b of this.queue) this.askedFor.add(b.hash)
    } else {
      // Refuse : ces blocs comptent comme vus ; seuls les prochains changements seront relus.
      for (const b of this.queue) this.memory.seen.set(b.hash, '')
      this.d.memory.save(this.d.agent.id, note.vaultId, note.docId, this.memory)
      this.queue = []
    }
    this.asking = null
    this.pump()
  }

  /** Blocs deja acceptes (gros collage) : ils ne redeclenchent pas la question. */
  private askedFor = new Set<string>()

  private pump(): void {
    if (this.stopped || !this.note) { this.emit(); return }
    if (this.asking) { this.emit(); return }
    const fresh = this.queue.filter(b => !this.askedFor.has(b.hash))
    if (fresh.length > this.askAbove) {
      this.asking = { count: fresh.length }
      this.emit()
      void this.ask(this.note, fresh.length)
      return
    }
    // Apres une erreur passagere : on attend le nouvel essai.
    if (this.retryTimer) { this.emit(); return }
    // Le bloc ou la personne tape attend : on ne travaille pas dans son paragraphe.
    const held = this.d.typing?.(this.note)?.blockHash
    while (this.running.size < this.concurrency) {
      const next = this.queue.findIndex(b => b.hash !== held)
      if (next < 0) break
      const refusal = this.d.canSpend?.() ?? null
      if (refusal) { this.fail(refusal); return }
      const [block] = this.queue.splice(next, 1)
      void this.analyze(this.note, block!)
    }
    this.waitTyping()
    this.emit()
  }

  /** Si le bloc ou elle tape est a relire : on y revient quand elle aura fini (un seul rappel). */
  private waitTyping(): void {
    if (this.typingTimer) { clearTimeout(this.typingTimer); this.typingTimer = null }
    const note = this.note
    const held = note ? this.d.typing?.(note) ?? null : null
    if (!held || !this.queue.some(b => b.hash === held.blockHash)) return
    this.typingTimer = setTimeout(() => { this.typingTimer = null; this.pump() }, Math.max(0, held.freeInMs) + 50)
  }

  private async analyze(note: WatchNote, block: NoteBlock): Promise<void> {
    const ac = new AbortController()
    this.running.set(block.hash, { hash: block.hash, ac })
    this.emit()
    const memory = this.memory
    try {
      const reviews = this.d.reviews?.(note) ?? []
      const answer = await this.d.chat({
        messages: watchMessages(this.d.agent, note, block, memory, reviews),
        // Large : un modele qui raisonne (gpt-5, o3...) compte aussi sa reflexion dans ce plafond.
        json: true, temperature: 0.2, maxTokens: 2000,
        ...(this.d.agent.model ? { model: this.d.agent.model } : {}),
        signal: ac.signal,
      })
      this.d.onUsage?.({ inputTokens: answer.usage?.inputTokens ?? 0, outputTokens: answer.usage?.outputTokens ?? 0 })
      if (ac.signal.aborted || this.running.get(block.hash)?.ac !== ac) return
      this.running.delete(block.hash)
      this.failures = 0
      this.warning = undefined
      const reply = parseWatchReply(answer.text, block.text) ?? { faults: [], advice: null, summary: '' }
      if (this.d.agent.watch?.advice === false) reply.advice = null
      // Deja propose, accepte ou refuse dans la Revision : jamais repropose. Conseil ecarte : non plus.
      const latest = this.d.reviews?.(note) ?? reviews
      reply.faults = reply.faults.filter(f => !alreadyReviewed(f, latest))
      if (reply.advice && (sameAdvice(reply.advice, memory.dismissed) || sameAdvice(reply.advice, memory.remarks))) reply.advice = null
      // La note a pu changer pendant l'analyse : le bloc doit y etre encore, tel quel.
      const current = this.note
      if (!current || current.docId !== note.docId || memory !== this.memory) return
      const now = current.blocks.find(b => b.hash === block.hash)
      memory.seen.set(block.hash, reply.summary)
      if (reply.advice) memory.remarks = [...memory.remarks, clip(reply.advice, 160)].slice(-MAX_REMARKS)
      this.d.memory.save(this.d.agent.id, note.vaultId, note.docId, memory)
      if (now) this.d.onFinding(current, now, reply)
    } catch (err) {
      if (this.running.get(block.hash)?.ac === ac) this.running.delete(block.hash)
      if (ac.signal.aborted || this.stopped) return
      const message = err instanceof Error ? err.message : String(err)
      // Erreur definitive, ou trop d'erreurs de suite : on arrete (reessayer couterait sans servir).
      if (isFatalWatchError(err) || ++this.failures >= MAX_FAILURES) { this.fail(message); return }
      // Passagere : le bloc revient dans la file, on reessaie un peu plus tard.
      this.warning = message
      if (this.note?.docId === note.docId && this.note.blocks.some(b => b.hash === block.hash) && !this.queue.some(b => b.hash === block.hash)) this.queue.push(block)
      this.emit()
      if (!this.retryTimer) {
        this.retryTimer = setTimeout(() => { this.retryTimer = null; this.pump() }, RETRY_MS * this.failures)
      }
      return
    }
    this.pump()
  }

  private fail(message: string): void {
    this.error = message
    this.stop()
  }

  private cancelAll(): void {
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null }
    if (this.typingTimer) { clearTimeout(this.typingTimer); this.typingTimer = null }
    for (const job of this.running.values()) job.ac.abort()
    this.running.clear()
  }

  private emit(): void {
    this.d.onState?.(this.status())
  }
}
