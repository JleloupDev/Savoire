// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Propositions de modification (suivi des modifications) : la partie
// application.
//
//  - Le mode suggestion est un etat de la personne (bouton du panneau
//    Revision, commande « Mode suggestion ») : tant qu'il est actif, l'editeur
//    de notes propose au lieu d'ecrire (SuggestionMode dans editor-core), et
//    les plugins qui le lisent (api.review.suggesting) font de meme.
//  - Les propositions d'une note sont des suggestions ancrees (ReviewService).
//    Celles des autres types de documents portent un type declare par leur
//    plugin (api.review.registerProposalType), qui sait les decrire et les
//    appliquer quand on les accepte.
//  - Tout vit dans la carte partagee « review » du vault : avec ou sans
//    serveur, visible de tous les membres.
import {
  TEXT_PROPOSAL, type ICRDT, type ProposalInfo, type ProposalTypeSpec, type ReviewAPI, type ReviewAnnotation,
  type TextCommentTarget, type TextProposalPayload,
} from '@savoire/plugin-api'
import { reviewOverlayExtension, suggestionModeExtension, type EditorHighlight } from '@savoire/editor-core'
import type { EditorController } from '@savoire/editor-core'
import {
  ReviewService, SuggestionModeStore, describeActor, mergeHunks,
  type IVaultSyncSession, type ReviewEntry, type ReviewText, type ReviewThread, type UserActor,
} from '@savoire/application'
import { renderAnnotationCard, renderDraftCard, type AnnotationCardDeps } from './AnnotationCard'

// ── Un service par session de vault ────────────────────────────────────────

const services = new WeakMap<IVaultSyncSession, ReviewService>()

export function reviewFor(session: IVaultSyncSession): ReviewService {
  let service = services.get(session)
  if (!service) { service = new ReviewService(session); services.set(session, service) }
  return service
}

/**
 * Le texte d'une note pour la revision : positions relatives (ancres) et
 * remplacement. La note est ouverte le temps de `use`, puis rendue.
 */
export function withReviewText<T>(session: IVaultSyncSession, docId: string, use: (text: ReviewText) => T): T | null {
  const crdt = session.openDocument(docId) as ICRDT
  try {
    const collab = crdt.collaborativeText?.()
    const shared = crdt.sharedText?.()
    if (!collab || !shared) return null
    const text: ReviewText = {
      toString: () => collab.toString(),
      get length() { return collab.length },
      createRelPos: (i, assoc) => collab.createRelPos(i, assoc),
      resolveRelPos: rp => collab.resolveRelPos(rp),
      slice: (a, b) => collab.slice(a, b),
      replace: (from, to, insert) => shared.applyDelta([
        ...(from > 0 ? [{ retain: from }] : []),
        ...(to > from ? [{ delete: to - from }] : []),
        ...(insert ? [{ insert }] : []),
      ]),
    }
    return use(text)
  } finally {
    session.closeDocument(docId)
  }
}

// ── Types de propositions des plugins ──────────────────────────────────────

const types = new Map<string, ProposalTypeSpec>()
const typeListeners = new Set<() => void>()

export function proposalType(type: string | undefined): ProposalTypeSpec | undefined {
  return type ? types.get(type) : undefined
}

export function onProposalTypesChange(cb: () => void): () => void {
  typeListeners.add(cb)
  return () => { typeListeners.delete(cb) }
}

// ── Mode suggestion ────────────────────────────────────────────────────────

let suggesting = false
const modeListeners = new Set<(on: boolean) => void>()

export function isSuggesting(): boolean { return suggesting }

export function onSuggestingChange(cb: (on: boolean) => void): () => void {
  modeListeners.add(cb)
  return () => { modeListeners.delete(cb) }
}

/** Change le mode, et le retient pour le compte dans le vault ouvert. */
export function setSuggesting(on: boolean): void {
  applySuggesting(on)
  modeStore?.set(on)
}

function applySuggesting(on: boolean): void {
  if (on === suggesting) return
  suggesting = on
  applyEditorMode()
  for (const cb of modeListeners) cb(on)
}

// Le mode est retenu par le compte, par vault (SuggestionModeStore : un
// canal d'index du vault). Il suit la personne d'un appareil a l'autre.
let modeStore: SuggestionModeStore | null = null
let modeOff: (() => void) | null = null

/**
 * Le vault ouvert et le compte : le mode retenu s'applique, et suit les
 * changements faits sur un autre appareil. `canWrite` faux (lecteur) : pas
 * de mode suggestion, une proposition est une ecriture.
 */
export function attachSuggestionMode(session: IVaultSyncSession | undefined, userId: string | undefined, canWrite: () => boolean = () => true): void {
  modeOff?.()
  modeOff = null
  modeStore = session && userId ? new SuggestionModeStore(session, userId) : null
  const store = modeStore
  if (!store) { applySuggesting(false); return }
  applySuggesting(canWrite() && store.get())
  modeOff = store.onChange(on => applySuggesting(on && canWrite()))
}

// ── Annotations dans le document ───────────────────────────────────────────
//
// Choix de la personne, sur cet appareil : voir et traiter la revision dans le
// document (cartes au clic sur les passages), ou seulement dans le panneau.
// Actif par defaut.

const INLINE_KEY = 'savoire.review.inline'

function readInline(): boolean {
  try { return globalThis.localStorage?.getItem(INLINE_KEY) !== 'off' } catch { return true }
}

let inline = readInline()
const inlineListeners = new Set<(on: boolean) => void>()

export function isInlineReview(): boolean { return inline }

export function onInlineReviewChange(cb: (on: boolean) => void): () => void {
  inlineListeners.add(cb)
  return () => { inlineListeners.delete(cb) }
}

export function setInlineReview(on: boolean): void {
  if (on === inline) return
  inline = on
  try { globalThis.localStorage?.setItem(INLINE_KEY, on ? 'on' : 'off') } catch { /* stockage indisponible : le choix vaut pour la session */ }
  for (const cb of inlineListeners) cb(on)
}

/** Ce que dit une proposition de plugin (son type la decrit). */
export function describeProposal(entry: ReviewEntry): string {
  const spec = proposalType(entry.proposalType)
  if (!spec) return `Proposition « ${entry.proposalType} » (son plugin n’est pas actif).`
  try { return spec.describe(entry.payload) } catch { return 'Proposition illisible.' }
}

/**
 * Accepte une suggestion de note ou une proposition de plugin. `hunks` :
 * seulement ces blocs de lignes (le reste du passage est garde).
 */
export async function acceptEntry(session: IVaultSyncSession, root: ReviewEntry, me: UserActor, hunks?: number[]): Promise<void> {
  if (root.kind === 'proposal') return acceptProposal(session, root, me, hunks)
  const done = withReviewText(session, root.docId, text => reviewFor(session).accept(root.id, text, me, hunks))
  if (!done) throw new Error('Note indisponible : ouvrez-la pour accepter la suggestion.')
}

/** Ce qu'il faut a la carte d'annotation pour agir au nom de la personne. */
export function annotationCardDeps(
  session: IVaultSyncSession,
  actor: () => UserActor | undefined,
  canWrite: () => boolean,
  openPanel?: () => void,
): AnnotationCardDeps {
  const review = reviewFor(session)
  const me = (): UserActor => {
    const a = actor()
    if (!a) throw new Error('Aucun compte connecté.')
    return a
  }
  return {
    review,
    canWrite: () => canWrite() && !!actor(),
    describeProposal,
    accept: root => acceptEntry(session, root, me()),
    reject: root => { review.setStatus(root.id, 'rejected', me()) },
    reply: (root, text) => { review.reply(root.id, text, me()) },
    resolve: (root, resolved) => { review.setStatus(root.id, resolved ? 'resolved' : 'open', me()) },
    ...(openPanel ? { openPanel } : {}),
  }
}

function toAnnotation({ root, replies }: ReviewThread): ReviewAnnotation {
  const name = (e: ReviewEntry) => describeActor(e.author)
  const isDefault = (root.kind === 'suggestion' && root.text === 'Suggestion') || (root.kind === 'proposal' && root.text === 'Proposition')
  return {
    id: root.id, docId: root.docId, kind: root.kind === 'edit' ? 'comment' : root.kind,
    text: isDefault ? '' : root.text,
    authorName: name(root), byAgent: root.author.kind === 'agent', createdAt: root.createdAt,
    status: root.status ?? 'open',
    ...(root.anchor ? { quote: root.anchor.quote } : {}),
    ...(root.replacement !== undefined ? { replacement: root.replacement } : {}),
    ...(root.proposalType ? { proposalType: root.proposalType, payload: root.payload } : {}),
    ...(root.target !== undefined ? { target: root.target } : {}),
    replies: replies.map(r => ({ id: r.id, text: r.text, authorName: name(r), byAgent: r.author.kind === 'agent', createdAt: r.createdAt })),
  }
}

/** Suit la revision du vault ouvert, meme quand la session change. */
function watchReview(session: () => IVaultSyncSession | undefined, cb: () => void): () => void {
  let stop: (() => void) | null = null
  let current: IVaultSyncSession | undefined
  const attach = () => {
    const s = session()
    if (s === current) return
    stop?.(); stop = null; current = s
    if (s) stop = reviewFor(s).onChange(cb)
  }
  attach()
  const timer = setInterval(attach, 1000)
  return () => { clearInterval(timer); stop?.() }
}

const isTextTarget = (v: unknown): v is TextCommentTarget =>
  !!v && typeof (v as TextCommentTarget).at === 'number' && typeof (v as TextCommentTarget).quote === 'string'

/** Passages d'un texte de plugin : propositions de texte et commentaires TextCommentTarget ouverts. */
export function pluginTextHighlights(threads: ReviewThread[], text: string): EditorHighlight[] {
  const out: EditorHighlight[] = []
  for (const { root } of threads) {
    if ((root.status ?? 'open') !== 'open') continue
    if (root.kind === 'proposal' && root.proposalType === TEXT_PROPOSAL) {
      const p = root.payload as TextProposalPayload | null
      if (!p || typeof p.before !== 'string' || typeof p.after !== 'string' || typeof p.at !== 'number') continue
      const at = p.before === '' && p.context?.left
        ? (() => { const i = locateText(text, p.context!.left, p.at - p.context!.left.length); return i < 0 ? -1 : i + p.context!.left.length })()
        : locateText(text, p.before, p.at)
      if (at < 0) continue
      out.push({
        from: at, to: at + p.before.length, id: root.id, className: 'review-mark review-mark-suggestion',
        title: `Proposition de ${describeActor(root.author)}`, ...(p.after ? { insert: p.after } : {}),
      })
    } else if (root.kind === 'comment' && isTextTarget(root.target) && root.target.quote) {
      const at = locateText(text, root.target.quote, root.target.at)
      if (at < 0) continue
      out.push({ from: at, to: at + root.target.quote.length, id: root.id, className: 'review-mark', title: `Commentaire : ${root.text.slice(0, 80)}` })
    }
  }
  return out
}

// ── L'editeur de notes actif ───────────────────────────────────────────────

interface EditorContext {
  editor: EditorController | null
  docId: () => string | undefined
  session: () => IVaultSyncSession | undefined
  actor: () => UserActor | undefined
  readOnly: () => boolean
}

let ctx: EditorContext | null = null
const proposeErrors = new Set<(message: string) => void>()

/** Erreurs des propositions faites en tapant (le panneau les affiche). */
export function onProposeError(cb: (message: string) => void): () => void {
  proposeErrors.add(cb)
  return () => { proposeErrors.delete(cb) }
}

/** L'editeur actif et de quoi proposer en son nom (appele a chaque changement d'editeur). */
export function setSuggestionEditor(context: EditorContext): void {
  if (ctx?.editor && ctx.editor !== context.editor) ctx.editor.setSuggestionMode?.(null)
  ctx = context
  applyEditorMode()
}

function applyEditorMode(): void {
  const editor = ctx?.editor
  if (!editor?.setSuggestionMode) return
  if (!suggesting || ctx!.readOnly()) { editor.setSuggestionMode(null); return }
  const context = ctx!
  editor.setSuggestionMode({
    propose(change) {
      const session = context.session()
      const docId = context.docId()
      const me = context.actor()
      try {
        if (!session || !docId || !me) throw new Error('Note indisponible : la suggestion n’a pas été enregistrée.')
        const done = withReviewText(session, docId, text => {
          const anchor = ReviewService.anchor(text, change.from, change.to)
          return reviewFor(session).suggest(docId, anchor, change.insert, me)
        })
        if (!done) throw new Error('Note indisponible : la suggestion n’a pas été enregistrée.')
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        for (const cb of proposeErrors) cb(message)
      }
    },
  })
}

// ── L'API des plugins (api.review) ─────────────────────────────────────────

function toInfo(e: ReviewEntry): ProposalInfo {
  return {
    id: e.id, docId: e.docId, type: e.proposalType ?? '', payload: e.payload,
    note: e.text === 'Proposition' ? '' : e.text,
    authorName: e.author.kind === 'agent' ? `${e.author.agentName}` : e.author.displayName,
    createdAt: e.createdAt,
    status: e.status === 'accepted' ? 'accepted' : e.status === 'rejected' ? 'rejected' : 'open',
  }
}

/** Le passage de `before` le plus proche de `at` dans `text` ; -1 s'il n'y est plus. */
export function locateText(text: string, before: string, at: number): number {
  if (before === '') return Math.min(Math.max(0, at), text.length)
  let best = -1
  for (let i = text.indexOf(before); i >= 0; i = text.indexOf(before, i + 1)) {
    if (best < 0 || Math.abs(i - at) < Math.abs(best - at)) best = i
  }
  return best
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)

/** Propositions de texte des editeurs des plugins (LaTeX...) : appliquees par editText. */
function textProposalType(editText: (docId: string, edit: (current: string) => string) => Promise<boolean>): ProposalTypeSpec {
  const asText = (payload: unknown): TextProposalPayload => {
    const p = payload as TextProposalPayload
    if (!p || typeof p.before !== 'string' || typeof p.after !== 'string' || typeof p.at !== 'number') throw new Error('Proposition de texte illisible.')
    return p
  }
  return {
    type: TEXT_PROPOSAL,
    label: 'Texte',
    describe(payload) {
      const p = asText(payload)
      if (!p.before) return `Ajouter « ${clip(p.after, 200)} »`
      if (!p.after) return `Supprimer « ${clip(p.before, 200)} »`
      return `« ${clip(p.before, 200)} » → « ${clip(p.after, 200)} »`
    },
    async apply(docId, payload) {
      const p = asText(payload)
      let conflict = false
      await editText(docId, current => {
        // Un ajout se repere par le texte qui l'entourait.
        const at = p.before === '' && p.context?.left
          ? (() => { const i = locateText(current, p.context!.left, p.at - p.context!.left.length); return i < 0 ? -1 : i + p.context!.left.length })()
          : locateText(current, p.before, p.at)
        if (at < 0) { conflict = true; return current }
        return current.slice(0, at) + p.after + current.slice(at + p.before.length)
      })
      if (conflict) throw new Error('Le passage a changé depuis la proposition.')
    },
  }
}

export function createReviewAPI(deps: {
  session(): IVaultSyncSession | undefined
  actor(): UserActor | undefined
  /** Modifier un document texte comme une frappe (VaultAPI.editText). */
  editText?(docId: string, edit: (current: string) => string): Promise<boolean>
  /** La personne peut ecrire dans le vault (sinon : ni commenter, ni decider). */
  canWrite?(): boolean
  /** Ouvrir le panneau Revision (lien des cartes). */
  openPanel?(): void
}): ReviewAPI {
  const canWrite = () => deps.canWrite?.() ?? true
  /** La session, le compte et un fil existant ; refuse si la personne ne peut pas ecrire. */
  const acting = (id?: string) => {
    const session = deps.session()
    const me = deps.actor()
    if (!session || !me) throw new Error('Aucun vault ouvert.')
    if (!canWrite()) throw new Error('Lecture seule : vous ne pouvez pas modifier la révision.')
    const thread = id ? reviewFor(session).thread(id) : undefined
    if (id && !thread) throw new Error(`fil introuvable : ${id}`)
    return { session, me, review: reviewFor(session), root: thread?.root }
  }
  const cardFor = (ids: string[], container: HTMLElement, onDone?: () => void): () => void => {
    const session = deps.session()
    if (!session) return () => {}
    return renderAnnotationCard(container, ids, annotationCardDeps(session, deps.actor, canWrite, deps.openPanel), onDone)
  }
  if (deps.editText) {
    const spec = textProposalType(deps.editText)
    types.set(spec.type, spec)
  }
  return {
    registerProposalType(spec: ProposalTypeSpec) {
      if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(spec.type)) throw new Error(`type de proposition invalide : ${spec.type}`)
      types.set(spec.type, spec)
      for (const cb of typeListeners) cb()
      return () => {
        if (types.get(spec.type) === spec) types.delete(spec.type)
        for (const cb of typeListeners) cb()
      }
    },
    async propose(docId, type, payload, note) {
      const session = deps.session()
      const me = deps.actor()
      if (!session || !me) throw new Error('Aucun vault ouvert.')
      return reviewFor(session).propose(docId, type, payload, me, note ?? '').id
    },
    list(docId, type) {
      const session = deps.session()
      if (!session) return []
      return reviewFor(session).list(docId)
        .filter(e => e.kind === 'proposal' && !e.parentId && (!type || e.proposalType === type))
        .map(toInfo)
    },
    onChange(cb) {
      // La session change avec le vault : on se reabonne a la volee.
      return watchReview(deps.session, cb)
    },
    get suggesting() { return suggesting },
    onSuggestingChange: onSuggestingChange,
    get inline() { return inline },
    onInlineChange: onInlineReviewChange,
    annotations(docId) {
      const session = deps.session()
      if (!session) return []
      return reviewFor(session).threads(docId).filter(t => t.root.kind !== 'edit').map(toAnnotation)
    },
    async comment(docId, text, target, options) {
      const { review, me } = acting()
      return review.comment(docId, text, me, undefined, target, undefined, options?.mark ? { mark: true } : undefined).id
    },
    async removeMark(id) {
      const { review, me, root } = acting(id)
      if (!root!.mark) throw new Error('ce fil n\'est pas une marque')
      review.setStatus(root!.id, 'rejected', me)
    },
    async reply(id, text) {
      const { review, me } = acting(id)
      review.reply(id, text, me)
    },
    async accept(id) {
      const { session, me, root } = acting(id)
      if (root!.kind !== 'suggestion' && root!.kind !== 'proposal') throw new Error('ce fil n\'est ni une suggestion ni une proposition')
      await acceptEntry(session, root!, me)
    },
    async reject(id) {
      const { review, me, root } = acting(id)
      if (root!.kind !== 'suggestion' && root!.kind !== 'proposal') throw new Error('ce fil n\'est ni une suggestion ni une proposition')
      if ((root!.status ?? 'open') !== 'open') throw new Error('deja traite')
      review.setStatus(root!.id, 'rejected', me)
    },
    async resolve(id, resolved = true) {
      const { review, me, root } = acting(id)
      if (root!.kind !== 'comment') throw new Error('seul un commentaire se resout')
      review.setStatus(root!.id, resolved ? 'resolved' : 'open', me)
    },
    renderAnnotation(ids, container, options) {
      return cardFor(ids, container, options?.onDone)
    },
    renderDraft(container, draft, options) {
      const done = () => options?.onDone?.()
      if (draft.kind === 'suggestion' && (!draft.proposalType || !draft.toPayload)) throw new Error('suggestion sans type de proposition')
      return renderDraftCard(container, { kind: draft.kind, quote: draft.quote ?? '' }, (text, replacement) => {
        const { review, me } = acting()
        if (draft.kind === 'suggestion') {
          if (replacement === (draft.quote ?? '')) throw new Error('La suggestion ne change rien.')
          review.propose(draft.docId, draft.proposalType!, draft.toPayload!(replacement), me, text)
        } else {
          review.comment(draft.docId, text, me, undefined, draft.target)
        }
      }, done)
    },
    inlineAnnotations(docId) {
      return reviewOverlayExtension(
        { render: (ids, dom, close) => (inline ? cardFor(ids, dom, close) : () => {}) },
        {
          ranges(text) {
            const session = deps.session()
            return inline && session ? pluginTextHighlights(reviewFor(session).threads(docId), text) : []
          },
          subscribe(onChange) {
            const offReview = watchReview(deps.session, onChange)
            const offInline = onInlineReviewChange(onChange)
            return () => { offReview(); offInline() }
          },
        },
      )
    },
    textSuggestions(docId) {
      return suggestionModeExtension(() => suggesting ? {
        propose(change, read) {
          const session = deps.session()
          const me = deps.actor()
          if (!session || !me) return
          const payload: TextProposalPayload = {
            at: change.from,
            before: read(change.from, change.to),
            after: change.insert,
            context: { left: read(change.from - 40, change.from), right: read(change.to, change.to + 40) },
          }
          try { reviewFor(session).propose(docId, TEXT_PROPOSAL, payload, me) }
          catch (err) { for (const cb of proposeErrors) cb(err instanceof Error ? err.message : String(err)) }
        },
      } : null)
    },
  }
}

/**
 * Accepte la proposition d'un plugin : son type l'applique au document, puis
 * elle passe a « acceptee ». Si le plugin n'est pas la, ou si l'application
 * echoue, elle reste ouverte.
 */
/** Le texte avant et apres d'une proposition de texte (« savoire.text »), sinon null. */
export function textOfProposal(entry: ReviewEntry): { before: string; after: string } | null {
  if (entry.proposalType !== TEXT_PROPOSAL) return null
  const p = entry.payload as TextProposalPayload | null
  return p && typeof p.before === 'string' && typeof p.after === 'string' ? { before: p.before, after: p.after } : null
}

/**
 * Accepte une proposition. `hunks` (proposition de texte) : seulement ces
 * blocs de lignes (voir lineHunks), le reste du passage est garde.
 */
export async function acceptProposal(session: IVaultSyncSession, entry: ReviewEntry, me: UserActor, hunks?: number[]): Promise<void> {
  const spec = proposalType(entry.proposalType)
  if (!spec) throw new Error(`Le plugin qui sait appliquer cette proposition (${entry.proposalType}) n’est pas actif.`)
  const text = hunks ? textOfProposal(entry) : null
  const payload = text ? { ...(entry.payload as TextProposalPayload), after: mergeHunks(text.before, text.after, hunks!) } : entry.payload
  await spec.apply(entry.docId, payload)
  reviewFor(session).markApplied(entry.id, me)
}
