// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Panneau « Revision » : les commentaires de la note active.
//
// Un commentaire vise la note entiere ou un passage (ancre qui suit les
// modifications). Une suggestion propose de remplacer un passage : on
// l'accepte (la note change) ou on la refuse. Les passages vises sont
// surlignes dans l'editeur ; un clic sur la citation y mene.
// Les agents (ADR-033) ont leur propre panneau (AssistantWidget) ; ce qu'ils
// proposent arrive ici, sous leur nom : « Archiviste (IA), pour Jean ».
import { useEffect, useMemo, useRef, useState } from 'react'
import { describePdfTarget, isPdfTarget, type Widget } from '@savoire/plugin-api'
import type { EditorController } from '@savoire/editor-core'
import type { WorkspaceManagerImpl } from '@savoire/workspace'
import {
  REVIEW_STATUSES, ReviewService, describeActor,
  type IVaultSyncSession, type ReviewAnchor, type ReviewEntry, type ReviewStatus,
  type ReviewThread, type UserActor,
  lineHunks, type LineHunk,
} from '@savoire/application'
import { openCompare } from './CompareView'
import type { EditorAreaRefs } from './EditorAreaWidget'
import {
  acceptEntry, acceptProposal, describeProposal, isInlineReview, isSuggesting, onInlineReviewChange, onProposalTypesChange,
  onProposeError, onSuggestingChange, proposalType, reviewFor, setInlineReview, setSuggesting, textOfProposal, withReviewText,
} from './reviewProposals'
import { showReviewHighlights } from './inlineReview'
import { commentOrAsk, draftAskDeps, replyOrAsk, requestCardDeps } from './agents/agentRequests'
import { AiChangesSection } from './AiChangesSection'

export { withReviewText } from './reviewProposals'

// ── Editeur actif : selection, passages surlignes ─────────────────────────

let activeEditor: EditorController | null = null

/** L'editeur actif (appele quand un editeur prend la main). */
export function setReviewEditor(ctrl: EditorController | null): void {
  activeEditor = ctrl
}

// ── Brouillons demandes depuis l'editeur ──────────────────────────────────

/** Brouillon : un commentaire ou une suggestion, sur un passage ou non. */
export interface ReviewDraft {
  kind: 'comment' | 'suggestion'
  docId?: string
  anchor?: ReviewAnchor
}

// Garde ici si le panneau n'est pas encore monte.
let pendingDraft: ReviewDraft | null = null
const draftListeners = new Set<(draft: ReviewDraft) => void>()

function startDraft(draft: ReviewDraft): void {
  if (draftListeners.size === 0) { pendingDraft = draft; return }
  for (const cb of draftListeners) cb(draft)
}

/**
 * « Commenter » / « Suggérer » sur la selection : ancre le passage tout de
 * suite (il suivra les modifications faites pendant qu'on ecrit).
 */
export function startReviewDraft(kind: 'comment' | 'suggestion', session: IVaultSyncSession | undefined, docId: string | undefined, from: number, to: number): void {
  const anchor = session && docId && to > from
    ? withReviewText(session, docId, text => ReviewService.anchor(text, from, to)) ?? undefined
    : undefined
  startDraft({ kind, ...(docId ? { docId } : {}), ...(anchor ? { anchor } : {}) })
}

/** Ancien point d'entree : un commentaire qui cite le texte (sans ancre). */
export function startCommentDraft(_selection: string): void {
  startDraft({ kind: 'comment' })
}

const BUTTON: React.CSSProperties = {
  fontSize: 12, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)',
  background: 'var(--accent)', color: 'white', fontWeight: 600, cursor: 'pointer',
}

function ReviewPanel({ manager, refs }: { manager: WorkspaceManagerImpl; refs: EditorAreaRefs }) {
  const [path, setPath] = useState<string | null>(() => manager.getActiveDocument()?.path ?? null)
  const [tick, setTick] = useState(0)
  const [draft, setDraft] = useState('')
  // Passage vise par le brouillon, et texte propose (suggestion).
  const [draftAnchor, setDraftAnchor] = useState<{ docId?: string; anchor: ReviewAnchor } | null>(null)
  const [draftKind, setDraftKind] = useState<'comment' | 'suggestion'>('comment')
  const [replacement, setReplacement] = useState('')
  // « Demander à… » : '' (personne), 'app:<id>' ou 'external:<id>'.
  const [askChoice, setAskChoice] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Mode suggestion (suivi des modifications) : la frappe devient des propositions.
  const [suggestMode, setSuggestMode] = useState(isSuggesting)
  useEffect(() => onSuggestingChange(setSuggestMode), [])
  useEffect(() => onProposeError(setError), [])
  // Un plugin declare ou retire un type de proposition.
  useEffect(() => onProposalTypesChange(() => setTick(t => t + 1)), [])

  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => {
    const take = (d: ReviewDraft) => {
      setDraftKind(d.kind)
      setDraftAnchor(d.anchor ? { docId: d.docId, anchor: d.anchor } : null)
      setReplacement(d.anchor?.quote ?? '')
      setDraft('')
      requestAnimationFrame(() => {
        const el = inputRef.current
        if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length) }
      })
    }
    if (pendingDraft !== null) { take(pendingDraft); pendingDraft = null }
    draftListeners.add(take)
    return () => { draftListeners.delete(take) }
  }, [])
  useEffect(() => manager.subscribeActiveDocument(p => { setPath(p) }), [manager])
  // Changement de vault : nouvelle session, donc nouveau service.
  useEffect(() => manager.subscribeVaultChange(() => setTick(t => t + 1)), [manager])

  const session = refs.vaultSession.current
  const client = refs.vaultAPI.current
  const review = useMemo(() => (session ? reviewFor(session) : null), [session, tick])
  useEffect(() => review?.onChange(() => setTick(t => t + 1)), [review])

  const docId = path ? client?.resolveDocumentId(path) : undefined

  // Panneau ouvert : les passages vises sont surlignes dans la note (meme
  // sans annotations dans la note, voir inlineReview).
  useEffect(() => showReviewHighlights(), [])
  const [inline, setInline] = useState(isInlineReview)
  useEffect(() => onInlineReviewChange(setInline), [])
  const account = refs.activeAccount.current
  const canWrite = !refs.isReadOnly.current && refs.selectedVault.current?.role !== 'viewer'

  if (!session || !client || !review || !account) {
    return <Shell><Muted>Ouvrez un vault pour voir la révision.</Muted></Shell>
  }
  if (!path || !docId) {
    return <Shell><Muted>Ouvrez une note pour voir ses commentaires.</Muted></Shell>
  }

  const me: UserActor = { kind: 'user', userId: account.userId, displayName: account.displayName }
  // Une marque retiree (surlignage, ancre d'un PDF) ne se montre plus ; la trace reste dans la carte.
  const threads = review.threads(docId).filter(t => !(t.root.mark && t.root.status === 'rejected'))
  const openProposals = threads.filter(t => (t.root.kind === 'suggestion' || t.root.kind === 'proposal') && (t.root.status ?? 'open') === 'open').length

  function act(action: () => void) {
    setError(null)
    try { action() } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
  }

  // Le brouillon vise-t-il bien la note affichee ?
  const anchorHere = draftAnchor && (!draftAnchor.docId || draftAnchor.docId === docId) ? draftAnchor.anchor : null
  const suggesting = draftKind === 'suggestion' && !!anchorHere

  // Le commentaire est-il adresse a un agent (« Demander à… », ou « @Nom ») ?
  const askAgents = suggesting ? [] : draftAskDeps.agents()
  const askTarget = askAgents.length && !suggesting ? draftAskDeps.resolve(draft, askChoice) : null
  const requests = requestCardDeps(session)

  function submit() {
    setError(null)
    try {
      if (suggesting) review!.suggest(docId!, anchorHere!, replacement, me, draft)
      else commentOrAsk(session!, docId!, draft, me, anchorHere ?? undefined, askTarget)
      setAskChoice('')
      setDraft('')
      setDraftAnchor(null)
      setDraftKind('comment')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  /** Montre le passage d'un fil dans l'editeur. */
  function reveal(entry: ReviewEntry) {
    // Un passage d'un PDF : la vue du PDF y va (suite de lien « ^ref »).
    if (isPdfTarget(entry.target)) { if (path) void manager.openFile(path, { subpath: `^${entry.target.ref}` }); return }
    if (!entry.anchor) return
    const at = withReviewText(session!, docId!, text => ReviewService.locate(entry.anchor!, text))
    if (!at) { setError('Ce passage n’existe plus dans la note.'); return }
    activeEditor?.selectRange?.(at.from, at.to)
    // Sa carte dans la marge, si la marge est affichee.
    activeEditor?.selectAnnotation?.(entry.id)
  }

  /** Accepte une suggestion ou une proposition ; `hunks` : seulement ces blocs de lignes. */
  function accept(root: ReviewEntry, hunks?: number[]) {
    setError(null)
    void acceptEntry(session!, root, me, hunks).catch(err => setError(err instanceof Error ? err.message : String(err)))
  }

  /**
   * « Comparer » une proposition d'un plugin : son type rend l'etat avant et
   * apres, la vue du type de fichier les affiche (CompareView). Undefined si
   * le type ne sait pas se comparer.
   */
  function compareHandler(root: ReviewEntry): (() => void) | undefined {
    if (root.kind !== 'proposal' || !path) return undefined
    const spec = proposalType(root.proposalType)
    const ext = path.split('.').pop()?.toLowerCase() ?? ''
    const fileSpec = refs.fileTypeRegistry.current?.resolve(ext)
    if (!spec?.compare || !fileSpec?.open) return undefined
    const open = (root.status ?? 'open') === 'open' && canWrite
    return () => {
      setError(null)
      void spec.compare!(root.docId, root.payload).then(({ before, after }) => openCompare({
        path: path!, spec: fileSpec, before, after,
        title: `Proposition de ${describeActor(root.author)}`,
        onAccept: open ? () => acceptProposal(session!, root, me) : undefined,
        onReject: open ? () => { review!.setStatus(root.id, 'rejected', me) } : undefined,
      })).catch(err => setError(err instanceof Error ? err.message : String(err)))
    }
  }

  // Les modifications de l'IA sont des points du texte de la note : rien a montrer pour un fichier ou un arbre.
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const fileType = refs.fileTypeRegistry.current?.resolve(ext)
  const textNote = ext === 'md' || (!!fileType && fileType.collaborationMode === 'crdt' && fileType.superType !== 'binary' && fileType.crdtRoot !== 'tree')

  /** Tout accepter ou tout refuser (suggestions et propositions ouvertes de la note). */
  async function all(decision: 'accept' | 'reject') {
    setError(null)
    const open = threads.filter(t => (t.root.kind === 'suggestion' || t.root.kind === 'proposal') && (t.root.status ?? 'open') === 'open')
    // Du bas vers le haut : accepter un passage ne decale pas les suivants.
    for (const t of open.reverse()) {
      try {
        if (decision === 'reject') review!.setStatus(t.root.id, 'rejected', me)
        else await acceptEntry(session!, t.root, me)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    }
  }


  return (
    <Shell>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
        <div style={{ flex: 1, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{path}</div>
        {/* Historique des versions (plugin core) : son panneau, a cote. */}
        {manager.views.getAll().some(v => v.id === 'history') && (
          <button data-testid="review-open-history" onClick={() => manager.toggleView('history')}
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--accent)', fontSize: 12, flexShrink: 0 }}>
            Versions
          </button>
        )}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 10, padding: '6px 8px', borderRadius: 6, background: suggestMode ? 'rgba(21,128,61,0.10)' : 'transparent', border: '1px solid var(--border)' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, flex: '1 1 100%', cursor: canWrite ? 'pointer' : 'default', fontSize: 12 }}>
          <input type="checkbox" data-testid="review-suggest-mode" checked={suggestMode} disabled={!canWrite}
            onChange={e => setSuggesting(e.target.checked)} />
          <span>
            <b>Mode suggestion</b>
            <span style={{ display: 'block', fontSize: 11, color: 'var(--text-faint)' }}>
              {suggestMode ? 'Vos modifications deviennent des propositions à accepter.' : 'Vous modifiez directement.'}
            </span>
          </span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, flex: '1 1 100%', cursor: 'pointer', fontSize: 12 }}>
          <input type="checkbox" data-testid="review-inline-mode" checked={inline}
            onChange={e => setInlineReview(e.target.checked)} />
          <span>
            <b>Annotations dans la note</b>
            <span style={{ display: 'block', fontSize: 11, color: 'var(--text-faint)' }}>
              {inline ? 'Les fils sont dans la marge, ou s’ouvrent d’un clic sur leur passage : répondre, accepter, refuser.' : 'Les fils ne se traitent qu’ici.'}
            </span>
          </span>
        </label>
        {canWrite && openProposals > 0 && (
          <>
            <button data-testid="review-accept-all" onClick={() => void all('accept')} style={{ ...SMALL, color: '#16a34a', borderColor: 'rgba(22,163,74,.5)' }}>Tout accepter</button>
            <button data-testid="review-reject-all" onClick={() => void all('reject')} style={SMALL}>Tout refuser</button>
          </>
        )}
      </div>
      {error && <div data-testid="review-error" style={{ color: 'var(--color-danger, #ef4444)', fontSize: 12, marginBottom: 8 }}>{error}</div>}

      {textNote && (
        <AiChangesSection key={docId} session={session} docId={docId} me={{ id: account.userId, name: account.displayName }} canWrite={canWrite} editor={() => activeEditor} />
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {threads.length === 0 && <Muted>Aucun commentaire.</Muted>}
        {threads.map(t => (
          <Thread
            key={t.root.id}
            thread={t}
            canWrite={canWrite}
            onReply={text => act(() => replyOrAsk(session, t.root, text, me))}
            request={t.root.request ? { line: requests.line(t.root), state: t.root.request.state, onRetry: requests.canRetry(t.root) ? () => act(() => requests.retry(t.root)) : undefined } : undefined}
            onStatus={status => act(() => review.setStatus(t.root.id, status, me))}
            onReveal={() => reveal(t.root)}
            onAccept={hunks => accept(t.root, hunks)}
            onCompare={compareHandler(t.root)}
          />
        ))}
      </div>

      {anchorHere && (
        <div data-testid="review-draft-anchor" style={{ marginTop: 12, display: 'flex', gap: 6, alignItems: 'flex-start' }}>
          <Quote text={anchorHere.quote} strike={suggesting} />
          <button title="Viser toute la note" data-testid="review-draft-unanchor" onClick={() => { setDraftAnchor(null); setDraftKind('comment') }}
            style={{ background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', fontSize: 14, lineHeight: 1 }}>×</button>
        </div>
      )}
      {suggesting && (
        <textarea
          data-testid="review-replacement"
          value={replacement}
          onChange={e => setReplacement(e.target.value)}
          placeholder="Texte proposé (vide : supprimer le passage)"
          style={{ width: '100%', boxSizing: 'border-box', marginTop: 6, minHeight: 50, padding: 8, borderRadius: 6, border: '1px solid rgba(34,197,94,.5)', background: 'rgba(34,197,94,.06)', color: 'inherit', font: 'inherit', fontSize: 12 }}
        />
      )}
      <textarea
        data-testid="review-input"
        ref={inputRef}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        disabled={!canWrite}
        placeholder={!canWrite ? 'Lecture seule : vous ne pouvez pas commenter.' : suggesting ? 'Explication (facultative)…' : askAgents.length ? 'Commenter, ou demander : @Nom…' : anchorHere ? 'Commenter ce passage…' : 'Écrire un commentaire…'}
        style={{ width: '100%', boxSizing: 'border-box', marginTop: anchorHere ? 6 : 12, minHeight: suggesting ? 36 : 60, padding: 8, borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 12 }}
      />
      {canWrite && askAgents.length > 0 && (
        <select data-testid="review-ask" value={askChoice} onChange={e => setAskChoice(e.target.value)}
          style={{ width: '100%', boxSizing: 'border-box', marginTop: 6, fontSize: 12, padding: '3px 6px', borderRadius: 4, border: '1px solid var(--border)', background: 'transparent', color: 'inherit' }}>
          <option value="">Demander à… (personne)</option>
          {draftAskDeps.inApp() && (
            <optgroup label="Dans Savoire, tout de suite">
              {askAgents.map(a => <option key={a.id} value={`app:${a.id}`}>{a.name}</option>)}
            </optgroup>
          )}
          <optgroup label="Par son IA externe (ChatGPT, Claude…)">
            {askAgents.map(a => <option key={a.id} value={`external:${a.id}`}>{a.name}</option>)}
          </optgroup>
        </select>
      )}
      {askTarget && (
        <div data-testid="review-ask-hint" style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 4 }}>
          {askTarget.via === 'app'
            ? `${askTarget.agent.name} répondra dans ce fil${anchorHere ? ', et n’écrira que dans ce passage' : ''}.`
            : `${askTarget.agent.name} verra cette demande par son IA externe, et répondra dans ce fil.`}
        </div>
      )}
      <button data-testid="review-submit" style={{ ...BUTTON, marginTop: 6 }}
        disabled={!canWrite || (suggesting ? replacement === anchorHere!.quote : !draft.trim())} onClick={submit}>
        {suggesting ? 'Suggérer' : askTarget ? 'Demander' : 'Commenter'}
      </button>
      {error && <div style={{ color: 'var(--danger, #ef4444)', fontSize: 12, marginTop: 6 }}>{error}</div>}

    </Shell>
  )
}

const SUGGESTION_STATUS: Partial<Record<ReviewStatus, string>> = { accepted: 'Acceptée', rejected: 'Refusée' }

function Thread({ thread, canWrite, onReply, onStatus, onReveal, onAccept, onCompare, request }: {
  thread: ReviewThread
  canWrite: boolean
  /** Demande a un agent : ou elle en est ; `onRetry` si on peut la relancer. */
  request?: { line: string; state: string; onRetry?: () => void }
  onReply: (text: string) => void
  onStatus: (status: ReviewStatus) => void
  onReveal: () => void
  /** `hunks` : seulement ces blocs de lignes (acceptation ligne par ligne). */
  onAccept: (hunks?: number[]) => void
  /** Ouvre l'ecran Comparer (propositions des plugins qui savent se comparer). */
  onCompare?: () => void
}) {
  const [draft, setDraft] = useState('')
  const { root, replies } = thread
  const isComment = root.kind === 'comment'
  const isSuggestion = root.kind === 'suggestion' || root.kind === 'proposal'
  const open = (root.status ?? 'open') === 'open'
  // Texte sur plusieurs lignes : on peut n'en accepter qu'une partie.
  const pair = root.kind === 'suggestion' && root.anchor && root.replacement !== undefined
    ? { before: root.anchor.quote, after: root.replacement }
    : root.kind === 'proposal' ? textOfProposal(root) : null
  const hunks = pair && open && canWrite ? lineHunks(pair.before, pair.after) : []
  const [choosing, setChoosing] = useState(false)
  return (
    <div data-testid="review-thread" data-kind={root.kind} data-status={root.status ?? ''} style={{ display: 'flex', flexDirection: 'column', gap: 4, opacity: root.status && root.status !== 'open' ? 0.75 : 1 }}>
      <Entry entry={root} onReveal={onReveal} />
      {request && (
        <div data-testid="review-request" data-state={request.state} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-muted)' }}>
          <span style={{ fontWeight: 700, padding: '0 5px', borderRadius: 4, background: 'rgba(124, 58, 237, 0.15)', color: '#7c3aed' }}>IA</span>
          <span>{request.line}</span>
          {canWrite && request.onRetry && <button data-testid="review-request-retry" onClick={request.onRetry} style={SMALL}>Relancer</button>}
        </div>
      )}
      {isSuggestion && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-muted)' }}>
          {onCompare && <button data-testid="review-compare" onClick={onCompare} style={SMALL}>Comparer</button>}
          {open && canWrite && (
            <>
              <button data-testid="review-accept" onClick={() => onAccept()} style={{ ...SMALL, color: '#16a34a', borderColor: 'rgba(22,163,74,.5)' }}>Accepter</button>
              {hunks.length > 1 && <button data-testid="review-choose-lines" onClick={() => setChoosing(v => !v)} style={SMALL}>{choosing ? 'Fermer' : 'Choisir les lignes'}</button>}
              <button data-testid="review-reject" onClick={() => onStatus('rejected')} style={SMALL}>Refuser</button>
            </>
          )}
          {!open && <span data-testid="review-suggestion-status">{SUGGESTION_STATUS[root.status!] ?? root.status}{root.partial ? ' en partie' : ''}{root.statusBy ? ` par ${describeActor(root.statusBy)}` : ''}</span>}
        </div>
      )}
      {choosing && hunks.length > 1 && <LineChooser hunks={hunks} onAccept={chosen => { setChoosing(false); onAccept(chosen) }} />}
      {isComment && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-muted)' }}>
          <select
            data-testid="review-status"
            value={root.status ?? 'open'}
            disabled={!canWrite}
            onChange={e => onStatus(e.target.value as ReviewStatus)}
            style={{ fontSize: 11, padding: '1px 4px', borderRadius: 4, border: '1px solid var(--border)', background: 'transparent', color: 'inherit' }}
          >
            {REVIEW_STATUSES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
          {root.statusBy && root.status !== 'open' && <span>par {describeActor(root.statusBy)}</span>}
        </div>
      )}
      {replies.length > 0 && (
        <div style={{ marginLeft: 14, display: 'flex', flexDirection: 'column', gap: 4, borderLeft: '2px solid var(--border)', paddingLeft: 8 }}>
          {replies.map(r => <Entry key={r.id} entry={r} />)}
        </div>
      )}
      {(isComment || isSuggestion) && canWrite && (
        <div style={{ display: 'flex', gap: 6, marginLeft: 14 }}>
          <input
            data-testid="review-reply-input"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder="Répondre…"
            style={{ flex: 1, minWidth: 0, fontSize: 12, padding: '3px 6px', borderRadius: 4, border: '1px solid var(--border)', background: 'transparent', color: 'inherit' }}
          />
          <button
            data-testid="review-reply-submit"
            disabled={!draft.trim()}
            onClick={() => { onReply(draft); setDraft('') }}
            style={{ fontSize: 11, padding: '3px 8px', borderRadius: 4, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}
          >
            Répondre
          </button>
        </div>
      )}
    </div>
  )
}

/** Les blocs de lignes d'une suggestion, a cocher : seuls ceux-la seront acceptes. */
function LineChooser({ hunks, onAccept }: { hunks: LineHunk[]; onAccept: (chosen: number[]) => void }) {
  const [chosen, setChosen] = useState<Set<number>>(() => new Set(hunks.map(h => h.index)))
  const flip = (i: number) => setChosen(prev => { const next = new Set(prev); if (next.has(i)) next.delete(i); else next.add(i); return next })
  const line = (text: string, kind: 'removed' | 'added', key: string) => (
    <div key={key} style={{ whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono, monospace)', fontSize: 11, padding: '0 4px',
      background: kind === 'removed' ? 'rgba(239,68,68,.08)' : 'rgba(34,197,94,.09)', textDecoration: kind === 'removed' ? 'line-through' : 'none' }}>
      {kind === 'removed' ? '− ' : '+ '}{text || ' '}
    </div>
  )
  return (
    <div data-testid="review-line-chooser" style={{ display: 'flex', flexDirection: 'column', gap: 6, marginLeft: 14, padding: 6, border: '1px solid var(--border)', borderRadius: 6 }}>
      {hunks.map(h => (
        <label key={h.index} data-testid="review-hunk" style={{ display: 'flex', gap: 6, alignItems: 'flex-start', cursor: 'pointer' }}>
          <input type="checkbox" data-testid="review-hunk-check" checked={chosen.has(h.index)} onChange={() => flip(h.index)} style={{ marginTop: 2 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            {h.removed.map((l, i) => line(l, 'removed', `r${i}`))}
            {h.added.map((l, i) => line(l, 'added', `a${i}`))}
          </div>
        </label>
      ))}
      <button data-testid="review-accept-lines" disabled={chosen.size === 0} onClick={() => onAccept([...chosen].sort((a, b) => a - b))}
        style={{ ...SMALL, alignSelf: 'flex-start', color: '#16a34a', borderColor: 'rgba(22,163,74,.5)' }}>
        Accepter {chosen.size} bloc{chosen.size > 1 ? 's' : ''} sur {hunks.length}
      </button>
    </div>
  )
}

const SMALL: React.CSSProperties = {
  fontSize: 11, padding: '2px 8px', borderRadius: 4, border: '1px solid var(--border)',
  background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer',
}

/** Passage cite. Barre : le texte qu'une suggestion remplacerait. */
function Quote({ text, strike, onClick }: { text: string; strike?: boolean; onClick?: () => void }) {
  const short = text.length > 280 ? `${text.slice(0, 280)}…` : text
  return (
    <div
      data-testid="review-quote"
      onClick={onClick}
      title={onClick ? 'Montrer le passage dans la note' : undefined}
      style={{
        flex: 1, minWidth: 0, fontSize: 12, padding: '3px 8px', borderLeft: `3px solid ${strike ? 'rgba(239,68,68,.6)' : 'rgba(234,179,8,.7)'}`,
        background: strike ? 'rgba(239,68,68,.06)' : 'rgba(234,179,8,.08)', whiteSpace: 'pre-wrap', color: 'var(--text-muted)',
        textDecoration: strike ? 'line-through' : 'none', cursor: onClick ? 'pointer' : 'default', borderRadius: 3,
      }}
    >{short || '(position)'}</div>
  )
}

/** Le passage vise par un commentaire de plugin (TextCommentTarget, cellule...), s'il le dit. */
/** « Surlignage jaune », « Ancre « Tableau » », « Commentaire du PDF ». */
function pdfMarkLabel(t: { mark?: string; color?: string; label?: string }): string {
  if (t.mark === 'highlight') return `Surlignage${t.color ? ` ${t.color}` : ''}`
  if (t.mark === 'anchor') return `Ancre${t.label ? ` « ${t.label} »` : ''}`
  return 'Commentaire du PDF'
}

function targetQuote(target: unknown): string | null {
  const q = (target as { quote?: unknown } | null)?.quote
  return typeof q === 'string' && q ? q : null
}

function Entry({ entry, onReveal }: { entry: ReviewEntry; onReveal?: () => void }) {
  const isAgent = entry.author.kind === 'agent'
  return (
    <div
      data-testid="review-entry"
      data-kind={entry.kind}
      data-author-kind={entry.author.kind}
      style={{ padding: 8, borderRadius: 6, border: '1px solid var(--border)', background: entry.kind === 'edit' ? 'rgba(234,179,8,0.08)' : 'var(--bg-surface)' }}
    >
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11, color: 'var(--text-muted)' }}>
        {isAgent && <span style={{ fontWeight: 700, padding: '1px 5px', borderRadius: 4, background: 'rgba(124,58,237,0.15)', color: '#7c3aed' }}>IA</span>}
        <span data-testid="review-author">{describeActor(entry.author)}</span>
        <span>· {new Date(entry.createdAt).toLocaleString()}</span>
      </div>
      {entry.anchor && (
        <div style={{ marginTop: 4 }}><Quote text={entry.anchor.quote} strike={entry.kind === 'suggestion'} onClick={onReveal} /></div>
      )}
      {!entry.anchor && isPdfTarget(entry.target) && (
        <div data-testid="review-pdf-target" style={{ marginTop: 4 }}>
          <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{pdfMarkLabel(entry.target)}</div>
          <Quote text={describePdfTarget(entry.target)} onClick={onReveal} />
        </div>
      )}
      {!entry.anchor && !isPdfTarget(entry.target) && targetQuote(entry.target) && (
        <div style={{ marginTop: 4 }}><Quote text={targetQuote(entry.target)!} /></div>
      )}
      {entry.kind === 'suggestion' && (
        <div data-testid="review-replacement-text" style={{ marginTop: 3, fontSize: 12, padding: '3px 8px', borderLeft: '3px solid rgba(34,197,94,.6)', background: 'rgba(34,197,94,.07)', whiteSpace: 'pre-wrap', borderRadius: 3 }}>
          {entry.replacement || <i style={{ color: 'var(--text-faint)' }}>(supprimer le passage)</i>}
        </div>
      )}
      {entry.kind === 'proposal' && <ProposalBody entry={entry} />}
      {!(entry.kind === 'suggestion' && entry.text === 'Suggestion') && !(entry.kind === 'proposal' && entry.text === 'Proposition') && (
        <div style={{ marginTop: 4, fontSize: 12, whiteSpace: 'pre-wrap', color: 'var(--text)' }}>
          {entry.kind === 'edit' ? `✎ ${entry.text}` : entry.text}
        </div>
      )}
    </div>
  )
}

/** Proposition d'un plugin : son type la decrit (et la dessine, s'il sait). */
function ProposalBody({ entry }: { entry: ReviewEntry }) {
  const spec = proposalType(entry.proposalType)
  const box = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = box.current
    if (!el || !spec?.render) return
    el.replaceChildren()
    let cleanup: void | (() => void)
    try { cleanup = spec.render(entry.payload, el) } catch (err) { el.textContent = `Aperçu impossible : ${String(err)}` }
    return () => { if (typeof cleanup === 'function') cleanup() }
  }, [spec, entry.payload])
  const description = describeProposal(entry)
  return (
    <div data-testid="review-proposal" data-type={entry.proposalType} style={{ marginTop: 4, fontSize: 12, padding: '3px 8px', borderLeft: '3px solid rgba(34,197,94,.6)', background: 'rgba(34,197,94,.07)', borderRadius: 3 }}>
      <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{spec?.label ?? 'Proposition'}</div>
      <div data-testid="review-proposal-text" style={{ whiteSpace: 'pre-wrap' }}>{description}</div>
      {spec?.render && <div ref={box} style={{ marginTop: 4 }} />}
    </div>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div data-testid="review-panel" style={{ height: '100%', overflowY: 'auto', padding: '12px 14px', boxSizing: 'border-box', fontFamily: 'var(--font-ui, sans-serif)', fontSize: 13, color: 'var(--text)', background: 'var(--bg-surface, #1e1e2e)' }}>
      {children}
    </div>
  )
}

function Muted({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>{children}</div>
}

export class ReviewWidget implements Widget {
  constructor(private readonly manager: WorkspaceManagerImpl, private readonly refs: EditorAreaRefs) {}

  render() {
    return <ReviewPanel manager={this.manager} refs={this.refs} />
  }

  dispose() {}
}
