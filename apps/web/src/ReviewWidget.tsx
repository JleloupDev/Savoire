// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Panneau « Revision » : les commentaires de la note active, et les agents.
//
// Un commentaire vise la note entiere ou un passage (ancre qui suit les
// modifications). Une suggestion propose de remplacer un passage : on
// l'accepte (la note change) ou on la refuse. Les passages vises sont
// surlignes dans l'editeur ; un clic sur la citation y mene.
// Un agent se lance sur la note active, dans un mode qui
// debloque des droits (lecture, relecture, redaction), toujours bornes par
// ceux de la personne qui le lance. Ce qu'il fait porte « agent, pour Jean ».
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ICRDT, Widget } from '@savoire/plugin-api'
import type { EditorController } from '@savoire/editor-core'
import type { WorkspaceManagerImpl } from '@savoire/workspace'
import {
  AGENT_MODES, REVIEW_STATUSES, ReviewService, describeActor, runAgent,
  type AgentRunResult, type IVaultSyncSession, type ReviewAnchor, type ReviewEntry, type ReviewStatus, type ReviewText,
  type ReviewThread, type UserActor,
} from '@savoire/application'
import { aiService } from './aiService'
import type { EditorAreaRefs } from './EditorAreaWidget'

// Un service par session de vault : la carte partagee est ouverte une fois.
const services = new WeakMap<IVaultSyncSession, ReviewService>()
function reviewFor(session: IVaultSyncSession): ReviewService {
  let service = services.get(session)
  if (!service) { service = new ReviewService(session); services.set(session, service) }
  return service
}

// ── Editeur actif : selection, passages surlignes ─────────────────────────

let activeEditor: EditorController | null = null
const editorListeners = new Set<() => void>()

/** L'editeur actif (appele quand un editeur prend la main). */
export function setReviewEditor(ctrl: EditorController | null): void {
  activeEditor = ctrl
  for (const cb of editorListeners) cb()
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
  const [modeId, setModeId] = useState<string>('review')
  const [run, setRun] = useState<AgentRunResult | null>(null)
  const [error, setError] = useState<string | null>(null)

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
  useEffect(() => manager.subscribeActiveDocument(p => { setPath(p); setRun(null) }), [manager])
  // Changement de vault : nouvelle session, donc nouveau service.
  useEffect(() => manager.subscribeVaultChange(() => setTick(t => t + 1)), [manager])
  // Un plugin qui propose des agents est installe, coupe ou retire.
  useEffect(() => {
    const onPlugins = () => setTick(t => t + 1)
    window.addEventListener('savoire-plugins-changed', onPlugins)
    return () => window.removeEventListener('savoire-plugins-changed', onPlugins)
  }, [])

  const session = refs.vaultSession.current
  const client = refs.vaultAPI.current
  const review = useMemo(() => (session ? reviewFor(session) : null), [session, tick])
  useEffect(() => review?.onChange(() => setTick(t => t + 1)), [review])

  const docId = path ? client?.resolveDocumentId(path) : undefined

  // Passages vises par les fils ouverts : surlignes dans l'editeur.
  const [editorTick, setEditorTick] = useState(0)
  useEffect(() => {
    const cb = () => setEditorTick(t => t + 1)
    editorListeners.add(cb)
    return () => { editorListeners.delete(cb) }
  }, [])
  useEffect(() => {
    if (!review || !session || !docId || !activeEditor?.setHighlights) return
    const ranges = withReviewText(session, docId, text => review.threads(docId)
      .filter(t => t.root.anchor && (t.root.status ?? 'open') === 'open')
      .flatMap(t => {
        const at = ReviewService.locate(t.root.anchor!, text)
        return at && at.to > at.from ? [{
          from: at.from, to: at.to, id: t.root.id,
          className: t.root.kind === 'suggestion' ? 'review-mark review-mark-suggestion' : 'review-mark',
          title: t.root.kind === 'suggestion' ? 'Suggestion (panneau Révision)' : `Commentaire : ${t.root.text.slice(0, 80)}`,
        }] : []
      })) ?? []
    activeEditor.setHighlights(ranges)
  }, [review, session, docId, tick, editorTick])
  const account = refs.activeAccount.current
  const canWrite = !refs.isReadOnly.current && refs.selectedVault.current?.role !== 'viewer'

  if (!session || !client || !review || !account) {
    return <Shell><Muted>Ouvrez un vault pour voir la révision.</Muted></Shell>
  }
  if (!path || !docId) {
    return <Shell><Muted>Ouvrez une note pour voir ses commentaires.</Muted></Shell>
  }

  const me: UserActor = { kind: 'user', userId: account.userId, displayName: account.displayName }
  // Agents proposes par les plugins actifs.
  const agents = refs.pluginAPI.current?.agents?.getAll() ?? []
  const threads = review.threads(docId)

  function act(action: () => void) {
    setError(null)
    try { action() } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
  }

  // Le brouillon vise-t-il bien la note affichee ?
  const anchorHere = draftAnchor && (!draftAnchor.docId || draftAnchor.docId === docId) ? draftAnchor.anchor : null
  const suggesting = draftKind === 'suggestion' && !!anchorHere

  function submit() {
    setError(null)
    try {
      if (suggesting) review!.suggest(docId!, anchorHere!, replacement, me, draft)
      else review!.comment(docId!, draft, me, anchorHere ?? undefined)
      setDraft('')
      setDraftAnchor(null)
      setDraftKind('comment')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  /** Montre le passage d'un fil dans l'editeur. */
  function reveal(entry: ReviewEntry) {
    if (!entry.anchor) return
    const at = withReviewText(session!, docId!, text => ReviewService.locate(entry.anchor!, text))
    if (!at) { setError('Ce passage n’existe plus dans la note.'); return }
    activeEditor?.selectRange?.(at.from, at.to)
  }

  function accept(rootId: string) {
    act(() => {
      const done = withReviewText(session!, docId!, text => review!.accept(rootId, text, me))
      if (!done) throw new Error('Note indisponible : ouvrez-la pour accepter la suggestion.')
    })
  }

  async function launch(agentId: string) {
    const agent = agents.find(a => a.id === agentId)
    if (!agent) return
    const mode = AGENT_MODES.find(m => m.id === modeId)!
    setRun(await runAgent({
      agent, mode,
      user: { userId: me.userId, displayName: me.displayName, canWrite },
      target: { docId: docId!, path: path! },
      client: client!, session: session!, review: review!,
      // L'IA de la personne (absente si aucune connexion n'est configuree).
      ...(aiService.connections().length ? { ai: { chat: (req: Parameters<typeof aiService.chat>[0]) => aiService.chat(req) } } : {}),
    }))
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

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {threads.length === 0 && <Muted>Aucun commentaire.</Muted>}
        {threads.map(t => (
          <Thread
            key={t.root.id}
            thread={t}
            canWrite={canWrite}
            onReply={text => act(() => review.reply(t.root.id, text, me))}
            onStatus={status => act(() => review.setStatus(t.root.id, status, me))}
            onReveal={() => reveal(t.root)}
            onAccept={() => accept(t.root.id)}
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
        placeholder={!canWrite ? 'Lecture seule : vous ne pouvez pas commenter.' : suggesting ? 'Explication (facultative)…' : anchorHere ? 'Commenter ce passage…' : 'Écrire un commentaire…'}
        style={{ width: '100%', boxSizing: 'border-box', marginTop: anchorHere ? 6 : 12, minHeight: suggesting ? 36 : 60, padding: 8, borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 12 }}
      />
      <button data-testid="review-submit" style={{ ...BUTTON, marginTop: 6 }}
        disabled={!canWrite || (suggesting ? replacement === anchorHere!.quote : !draft.trim())} onClick={submit}>
        {suggesting ? 'Suggérer' : 'Commenter'}
      </button>
      {error && <div style={{ color: 'var(--danger, #ef4444)', fontSize: 12, marginTop: 6 }}>{error}</div>}

      <div style={{ borderTop: '1px solid var(--border)', marginTop: 16, paddingTop: 12 }}>
        <div style={{ fontWeight: 600, marginBottom: 6, color: 'var(--text)' }}>Agents</div>
        <Muted>Un agent agit en votre nom, avec au plus vos droits.</Muted>
        <select
          data-testid="agent-mode"
          value={modeId}
          onChange={e => setModeId(e.target.value)}
          style={{ marginTop: 8, width: '100%', padding: 4, borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'inherit', fontSize: 12 }}
        >
          {AGENT_MODES.map(m => <option key={m.id} value={m.id}>{m.label} — {m.description}</option>)}
        </select>
        {agents.length === 0 && <div style={{ marginTop: 8 }}><Muted>Aucun agent : installez un plugin d'agent depuis le store.</Muted></div>}
        {agents.map(a => (
          <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <div style={{ flex: 1, fontSize: 12 }}>
              <div style={{ fontWeight: 600 }}>{a.name}</div>
              <Muted>{a.description}</Muted>
            </div>
            <button data-testid="agent-run" data-agent-id={a.id} style={BUTTON} onClick={() => void launch(a.id)}>Lancer</button>
          </div>
        ))}
        {run && (
          <div data-testid="agent-log" data-ok={run.ok ? 'true' : 'false'} style={{ marginTop: 10, padding: 8, borderRadius: 6, background: 'var(--bg-elevated)', fontSize: 12 }}>
            <Muted>Droits effectifs : {run.capabilities.join(', ')}</Muted>
            {run.log.map((line, i) => <div key={i} style={{ marginTop: 4 }}>{line}</div>)}
          </div>
        )}
      </div>
    </Shell>
  )
}

const SUGGESTION_STATUS: Partial<Record<ReviewStatus, string>> = { accepted: 'Acceptée', rejected: 'Refusée' }

function Thread({ thread, canWrite, onReply, onStatus, onReveal, onAccept }: {
  thread: ReviewThread
  canWrite: boolean
  onReply: (text: string) => void
  onStatus: (status: ReviewStatus) => void
  onReveal: () => void
  onAccept: () => void
}) {
  const [draft, setDraft] = useState('')
  const { root, replies } = thread
  const isComment = root.kind === 'comment'
  const isSuggestion = root.kind === 'suggestion'
  const open = (root.status ?? 'open') === 'open'
  return (
    <div data-testid="review-thread" data-kind={root.kind} data-status={root.status ?? ''} style={{ display: 'flex', flexDirection: 'column', gap: 4, opacity: root.status && root.status !== 'open' ? 0.75 : 1 }}>
      <Entry entry={root} onReveal={onReveal} />
      {isSuggestion && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-muted)' }}>
          {open && canWrite && (
            <>
              <button data-testid="review-accept" onClick={onAccept} style={{ ...SMALL, color: '#16a34a', borderColor: 'rgba(22,163,74,.5)' }}>Accepter</button>
              <button data-testid="review-reject" onClick={() => onStatus('rejected')} style={SMALL}>Refuser</button>
            </>
          )}
          {!open && <span data-testid="review-suggestion-status">{SUGGESTION_STATUS[root.status!] ?? root.status}{root.statusBy ? ` par ${describeActor(root.statusBy)}` : ''}</span>}
        </div>
      )}
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
      {entry.kind === 'suggestion' && (
        <div data-testid="review-replacement-text" style={{ marginTop: 3, fontSize: 12, padding: '3px 8px', borderLeft: '3px solid rgba(34,197,94,.6)', background: 'rgba(34,197,94,.07)', whiteSpace: 'pre-wrap', borderRadius: 3 }}>
          {entry.replacement || <i style={{ color: 'var(--text-faint)' }}>(supprimer le passage)</i>}
        </div>
      )}
      {!(entry.kind === 'suggestion' && entry.text === 'Suggestion') && (
        <div style={{ marginTop: 4, fontSize: 12, whiteSpace: 'pre-wrap', color: 'var(--text)' }}>
          {entry.kind === 'edit' ? `✎ ${entry.text}` : entry.text}
        </div>
      )}
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
