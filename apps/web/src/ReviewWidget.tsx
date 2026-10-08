// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Panneau « Revision » : les commentaires de la note active, et les agents.
//
// Version 1, volontairement simple : un commentaire vise une note entiere,
// sans ancrage. Un agent se lance sur la note active, dans un mode qui
// debloque des droits (lecture, relecture, redaction), toujours bornes par
// ceux de la personne qui le lance. Ce qu'il fait porte « agent, pour Jean ».
import { useEffect, useMemo, useState } from 'react'
import type { Widget } from '@savoire/plugin-api'
import type { WorkspaceManagerImpl } from '@savoire/workspace'
import {
  AGENT_MODES, REVIEW_STATUSES, ReviewService, describeActor, runAgent,
  type AgentRunResult, type IVaultSyncSession, type ReviewEntry, type ReviewStatus, type ReviewThread, type UserActor,
} from '@savoire/application'
import type { EditorAreaRefs } from './EditorAreaWidget'

// Un service par session de vault : la carte partagee est ouverte une fois.
const services = new WeakMap<IVaultSyncSession, ReviewService>()
function reviewFor(session: IVaultSyncSession): ReviewService {
  let service = services.get(session)
  if (!service) { service = new ReviewService(session); services.set(session, service) }
  return service
}

const BUTTON: React.CSSProperties = {
  fontSize: 12, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)',
  background: 'var(--accent)', color: 'white', fontWeight: 600, cursor: 'pointer',
}

function ReviewPanel({ manager, refs }: { manager: WorkspaceManagerImpl; refs: EditorAreaRefs }) {
  const [path, setPath] = useState<string | null>(() => manager.getActiveDocument()?.path ?? null)
  const [tick, setTick] = useState(0)
  const [draft, setDraft] = useState('')
  const [modeId, setModeId] = useState<string>('review')
  const [run, setRun] = useState<AgentRunResult | null>(null)
  const [error, setError] = useState<string | null>(null)

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

  function submit() {
    setError(null)
    try {
      review!.comment(docId!, draft, me)
      setDraft('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
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
    }))
  }

  return (
    <Shell>
      <div style={{ fontWeight: 600, marginBottom: 10, color: 'var(--text)' }}>{path}</div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {threads.length === 0 && <Muted>Aucun commentaire.</Muted>}
        {threads.map(t => (
          <Thread
            key={t.root.id}
            thread={t}
            canWrite={canWrite}
            onReply={text => act(() => review.reply(t.root.id, text, me))}
            onStatus={status => act(() => review.setStatus(t.root.id, status, me))}
          />
        ))}
      </div>

      <textarea
        data-testid="review-input"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        disabled={!canWrite}
        placeholder={canWrite ? 'Écrire un commentaire…' : 'Lecture seule : vous ne pouvez pas commenter.'}
        style={{ width: '100%', boxSizing: 'border-box', marginTop: 12, minHeight: 60, padding: 8, borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 12 }}
      />
      <button data-testid="review-submit" style={{ ...BUTTON, marginTop: 6 }} disabled={!canWrite || !draft.trim()} onClick={submit}>
        Commenter
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

function Thread({ thread, canWrite, onReply, onStatus }: {
  thread: ReviewThread
  canWrite: boolean
  onReply: (text: string) => void
  onStatus: (status: ReviewStatus) => void
}) {
  const [draft, setDraft] = useState('')
  const { root, replies } = thread
  const isComment = root.kind === 'comment'
  return (
    <div data-testid="review-thread" data-status={root.status ?? ''} style={{ display: 'flex', flexDirection: 'column', gap: 4, opacity: root.status && root.status !== 'open' ? 0.75 : 1 }}>
      <Entry entry={root} />
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
      {isComment && canWrite && (
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

function Entry({ entry }: { entry: ReviewEntry }) {
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
      <div style={{ marginTop: 4, fontSize: 12, whiteSpace: 'pre-wrap', color: 'var(--text)' }}>
        {entry.kind === 'edit' ? `✎ ${entry.text}` : entry.text}
      </div>
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
