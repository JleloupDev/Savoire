// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Panneau « Agents » (ADR-033) :
//  - Conversation : on choisit un agent, on lui parle ; il cherche, lit,
//    repond avec ses sources (liens cliquables) et agit selon ses droits. Une
//    action « demander » s'arrete ici et attend votre accord.
//  - Veille : un agent fait pour (Relecteur) suit la note ouverte et relit
//    ce qui change (agentWatch.ts) ; on l'allume ici.
//  - Activite : executions, tokens par jour et par agent, accords en attente
//    venus de l'exterieur (ChatGPT...), journal des actions externes.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentRun, ApprovalAnswer, ApprovalRequest } from '@savoire/agent-core'
import type { AIMessage, AgentDefinition, Widget } from '@savoire/plugin-api'
import type { WorkspaceManagerImpl } from '@savoire/workspace'
import type { EditorAreaRefs } from '../EditorAreaWidget'
import { agentDirectory, onAgentDirectoryChange, type AgentAction, type AgentApproval, type AgentUsageDay } from './agentDirectory'
import { clearRuns, listRuns, runAgentInApp } from './agentRunner'
import { agentWatch } from './agentWatch'

const BTN: React.CSSProperties = {
  fontSize: 12, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent',
  color: 'var(--text)', cursor: 'pointer',
}
const PRIMARY: React.CSSProperties = { ...BTN, background: 'var(--accent)', border: '1px solid var(--accent)', color: 'white', fontWeight: 600 }
const MUTED: React.CSSProperties = { fontSize: 12, color: 'var(--text-faint)' }
const CARD: React.CSSProperties = { padding: 8, borderRadius: 6, background: 'var(--bg-elevated)', fontSize: 12, marginTop: 8 }

interface Turn {
  input: string
  run?: AgentRun
  error?: string
}

interface PendingApproval {
  req: ApprovalRequest
  resolve: (a: ApprovalAnswer) => void
}

const fmt = (n: number): string => n.toLocaleString('fr-FR')

/** Le texte d'une reponse, avec les liens [[note]] cliquables. */
function Answer({ text, onOpen }: { text: string; onOpen: (path: string) => void }) {
  const parts = text.split(/(\[\[[^\]]+\]\])/g)
  return (
    <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.45 }}>
      {parts.map((p, i) => {
        const m = /^\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]$/.exec(p)
        return m
          ? <a key={i} href="#" onClick={e => { e.preventDefault(); onOpen(m[1]!.trim()) }} style={{ color: 'var(--accent)' }}>{p.slice(2, -2)}</a>
          : <span key={i}>{p}</span>
      })}
    </div>
  )
}

function Steps({ run }: { run: AgentRun }) {
  const [open, setOpen] = useState(false)
  const tools = run.steps.filter(s => s.kind === 'tool')
  return (
    <div style={{ marginTop: 6 }}>
      <button data-testid="agent-steps-toggle" style={{ ...BTN, padding: '1px 6px', fontSize: 11 }} onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} {tools.length} outil(s) · {fmt(run.usage.inputTokens + run.usage.outputTokens)} tokens{run.model ? ` · ${run.model}` : ''}
      </button>
      {open && run.steps.map(s => (
        <div key={s.id} style={{ ...MUTED, marginTop: 4, paddingLeft: 8, borderLeft: `2px solid ${s.status === 'error' || s.status === 'refused' ? 'var(--danger, #ef4444)' : 'var(--border)'}` }}>
          <b>{s.kind === 'model' ? 'IA' : s.name}</b>{s.mode && s.mode !== 'direct' ? ` (${s.mode})` : ''} · {s.status}
          {s.usage ? ` · ${fmt(s.usage.inputTokens + s.usage.outputTokens)} tokens` : ''}
          {s.kind === 'tool' && s.text ? <div style={{ whiteSpace: 'pre-wrap', maxHeight: 120, overflow: 'auto' }}>{s.text}</div> : null}
          {s.kind === 'delegate' ? <Delegation step={s} run={run.children?.find(c => c.id === s.childRunId)} /> : null}
        </div>
      ))}
    </div>
  )
}

/** Une delegation : la tache confiee, et l'execution du sous-agent, depliable. */
function Delegation({ step, run }: { step: AgentRun['steps'][number]; run: AgentRun | undefined }) {
  const [open, setOpen] = useState(false)
  const task = typeof step.args?.task === 'string' ? step.args.task : ''
  return (
    <div data-testid="agent-delegation">
      {task && <div style={{ whiteSpace: 'pre-wrap' }}>Tâche : {task.slice(0, 300)}</div>}
      {run && (
        <>
          <button data-testid="agent-delegation-toggle" style={{ ...BTN, padding: '1px 6px', fontSize: 11, marginTop: 2 }} onClick={() => setOpen(!open)}>
            {open ? '▾' : '▸'} {run.agentName} · {run.status === 'running' ? 'en cours' : run.status}
          </button>
          {open && (
            <div style={{ paddingLeft: 8 }}>
              {run.answer ? <div style={{ whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto' }}>{run.answer}</div> : <Live run={run} />}
              {run.error && <div style={{ color: 'var(--danger, #ef4444)' }}>{run.error}</div>}
              <Steps run={run} />
            </div>
          )}
        </>
      )}
      {!run && step.status === 'error' && step.text ? <div>{step.text}</div> : null}
    </div>
  )
}

/** Pendant l'execution : le texte de l'IA au fil de l'eau. */
function Live({ run }: { run: AgentRun }) {
  if (run.status !== 'running') return null
  const last = [...run.steps].reverse().find(s => s.kind === 'model')
  const text = last?.status === 'running' ? last.text : undefined
  return <div data-testid="agent-live" style={{ ...MUTED, whiteSpace: 'pre-wrap' }}>{text || '…'}</div>
}

/** Suit l'etat des veilles (re-rendu a chaque changement). */
function useWatchTick(): void {
  const [, setTick] = useState(0)
  useEffect(() => agentWatch.onChange(() => setTick(t => t + 1)), [])
}

/** Ce que fait la veille, en une ligne. */
function watchLine(agentId: string): string {
  const st = agentWatch.status(agentId)
  if (!agentWatch.isWatching(agentId)) return 'Il relit chaque passage qui change, après une pause de frappe.'
  if (st?.error) return `Arrêtée : ${st.error}`
  if (st?.asking) return `${st.asking} passages nouveaux à relire (environ ${fmt(agentWatch.askEstimate(agentId))} tokens).`
  if (st?.reading) return `Relit ${st.reading} passage(s)${st.pending ? `, ${st.pending} en attente` : ''}…`
  if (st?.pending) return `${st.pending} passage(s) en attente.`
  if (st?.docId) return 'À jour : il attend la prochaine pause de frappe.'
  return 'Ouvrez une note : il la suivra.'
}

/** En haut du panneau : les agents qui regardent la note en ce moment. */
function WatchBanner() {
  useWatchTick()
  const live = agentWatch.anyWatching().filter(w => !w.status.error)
  if (!live.length) return null
  return (
    <div data-testid="agent-watch-banner" style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '6px 12px', borderBottom: '1px solid var(--border)', background: 'rgba(124, 58, 237, 0.08)', fontSize: 12 }}>
      {live.map(({ agent, status }) => (
        <div key={agent.id} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span className={`agent-watch-dot${status.reading ? ' is-busy' : ''}`} />
          <b>En cours</b>
          <span style={{ color: 'var(--text-muted)' }}>{agent.name} · {watchLine(agent.id)}</span>
        </div>
      ))}
    </div>
  )
}

/** Veille de l'agent sur la note ouverte : l'allumer, son etat, le gros collage, le contexte donne. */
function WatchControl({ agent }: { agent: AgentDefinition }) {
  useWatchTick()
  const on = agentWatch.isWatching(agent.id)
  const st = agentWatch.status(agent.id)
  const context = on ? agentWatch.context(agent.id) : []
  return (
    <div data-testid="agent-watch-control" style={{ ...CARD, marginTop: 6 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <button data-testid="agent-watch-toggle" style={on ? BTN : PRIMARY} onClick={() => agentWatch.toggle(agent)}>
          {on ? 'Arrêter la veille' : '👁 Veiller sur la note'}
        </button>
        {on && !st?.error && <span data-testid="agent-watch-running" style={{ display: 'flex', gap: 4, alignItems: 'center', fontWeight: 600, color: '#7c3aed' }}><span className={`agent-watch-dot${st?.reading ? ' is-busy' : ''}`} />En cours</span>}
        {on && !st?.error && <button style={{ ...BTN, marginLeft: 'auto' }} title="Oublier ce qu’il a lu de cette note et tout relire (le contexte reste)" onClick={() => agentWatch.forget(agent.id)}>Tout relire</button>}
      </div>
      <div data-testid="agent-watch-status" style={{ ...MUTED, marginTop: 4 }}>{watchLine(agent.id)}</div>
      {on && !!st?.asking && (
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          <button style={PRIMARY} onClick={() => agentWatch.answer(agent.id, true)}>Relire</button>
          <button style={BTN} onClick={() => agentWatch.answer(agent.id, false)}>Passer</button>
        </div>
      )}
      {context.length > 0 && (
        <div data-testid="agent-watch-context" style={{ marginTop: 6 }}>
          <div style={MUTED}>Contexte donné pour cette note :</div>
          {context.map((c, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'baseline', marginTop: 2 }}>
              <span style={{ flex: 1, whiteSpace: 'pre-wrap' }}>• {c}</span>
              <button style={{ ...BTN, padding: '0 5px', fontSize: 11 }} title="Retirer" onClick={() => agentWatch.removeContext(agent.id, i)}>✕</button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function AssistantPanel({ manager, refs }: { manager: WorkspaceManagerImpl; refs: EditorAreaRefs }) {
  const [tab, setTab] = useState<'chat' | 'activity'>('chat')
  const [agents, setAgents] = useState<AgentDefinition[]>([])
  const [agentId, setAgentId] = useState<string>('')
  const [input, setInput] = useState('')
  const [turns, setTurns] = useState<Turn[]>([])
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<PendingApproval | null>(null)
  const [vaultTick, setVaultTick] = useState(0)
  const abort = useRef<AbortController | null>(null)

  useEffect(() => {
    const load = () => { void agentDirectory()?.list().then(setAgents, () => setAgents([])) }
    load()
    return onAgentDirectoryChange(load)
  }, [])
  useEffect(() => manager.subscribeVaultChange(() => { setVaultTick(t => t + 1); setTurns([]) }), [manager])

  const vault = refs.selectedVault.current
  const usable = useMemo(() => agents.filter(a => (!a.vaultId || a.vaultId === vault?.id) && (!a.scope?.vaultIds?.length || (vault && a.scope.vaultIds.includes(vault.id)))), [agents, vault?.id, vaultTick])
  const agent = usable.find(a => a.id === agentId) ?? usable[0]

  const openNote = (path: string) => {
    const client = refs.vaultAPI.current
    const id = client?.resolveDocumentId(path) ?? client?.resolveDocumentId(`${path}.md`)
    const meta = id ? client?.documents.find(d => d.id === id) : undefined
    void manager.openFile(meta?.path ?? path)
  }

  /** Sans texte : l'agent suit seulement ses instructions (bouton « Lancer »). */
  const LAUNCH = 'Fais ta tâche, en suivant tes instructions.'

  async function send(launch = false) {
    const text = launch ? LAUNCH : input.trim()
    const client = refs.vaultAPI.current
    const session = refs.vaultSession.current
    const account = refs.activeAccount.current
    if (!text || !agent || !client || !session || !account || !vault) return
    if (!launch) setInput('')
    setBusy(true)
    const index = turns.length
    setTurns(t => [...t, { input: text }])
    const history: AIMessage[] = turns.flatMap(t => t.run?.answer ? [{ role: 'user' as const, content: t.input }, { role: 'assistant' as const, content: t.run.answer }] : [])
    const active = manager.getActiveDocument()?.path
    const ctl = new AbortController()
    abort.current = ctl
    try {
      const run = await runAgentInApp({
        agent, input: active ? `${text}\n\n(Note ouverte : ${active})` : text, history,
        person: { userId: account.userId, displayName: account.displayName, canWrite: !refs.isReadOnly.current && vault.role !== 'viewer' },
        vaultId: vault.id, client, session,
        api: refs.pluginAPI.current as never,
        approve: req => new Promise<ApprovalAnswer>(resolve => setPending({ req, resolve })),
        onUpdate: r => setTurns(t => t.map((x, i) => (i === index ? { ...x, run: r } : x))),
        signal: ctl.signal,
      })
      setTurns(t => t.map((x, i) => (i === index ? { ...x, run } : x)))
    } catch (err) {
      setTurns(t => t.map((x, i) => (i === index ? { ...x, error: err instanceof Error ? err.message : String(err) } : x)))
    } finally {
      setBusy(false)
      setPending(null)
      abort.current = null
    }
  }

  const answer = (a: ApprovalAnswer) => { pending?.resolve(a); setPending(null) }

  return (
    <div data-testid="assistant-panel" style={{ height: '100%', display: 'flex', flexDirection: 'column', fontFamily: 'var(--font-ui, sans-serif)', fontSize: 13, color: 'var(--text)', background: 'var(--bg-surface, #1e1e2e)' }}>
      <div style={{ display: 'flex', gap: 4, padding: '8px 12px 0', borderBottom: '1px solid var(--border)' }}>
        {(['chat', 'activity'] as const).map(t => (
          <button key={t} data-testid={`assistant-tab-${t}`} onClick={() => setTab(t)}
            style={{ border: 'none', background: 'none', padding: '4px 8px', cursor: 'pointer', fontSize: 12, fontWeight: 600, color: tab === t ? 'var(--accent)' : 'var(--text-muted)', borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent' }}>
            {t === 'chat' ? 'Conversation' : 'Activité'}
          </button>
        ))}
      </div>
      <WatchBanner />
      {tab === 'activity' ? <Activity userId={refs.activeAccount.current?.userId ?? ''} /> : (
        <>
          <div style={{ flex: 1, overflowY: 'auto', padding: '10px 14px' }}>
            {!vault && <div style={MUTED}>Ouvrez un vault pour parler à un agent.</div>}
            {vault && usable.length === 0 && <div style={MUTED}>Aucun agent : créez-en un dans Paramètres → Agents.</div>}
            {turns.map((t, i) => (
              <div key={i} style={{ marginBottom: 12 }}>
                <div style={{ fontWeight: 600 }}>Vous</div>
                <div style={{ whiteSpace: 'pre-wrap' }}>{t.input}</div>
                <div style={{ fontWeight: 600, marginTop: 6, color: '#7c3aed' }}>{t.run?.agentName ?? agent?.name ?? 'Agent'} (IA)</div>
                {t.error && <div style={{ color: 'var(--danger, #ef4444)' }}>{t.error}</div>}
                {t.run?.answer && <Answer text={t.run.answer} onOpen={openNote} />}
                {t.run && !t.run.answer && <Live run={t.run} />}
                {t.run?.error && <div style={{ ...MUTED, color: 'var(--danger, #ef4444)' }}>{t.run.error}</div>}
                {t.run && t.run.sources.length > 0 && (
                  <div data-testid="agent-sources" style={{ ...MUTED, marginTop: 4 }}>
                    Sources : {t.run.sources.map((s, j) => (
                      <a key={s.docId} href="#" onClick={e => { e.preventDefault(); openNote(s.path) }} style={{ color: 'var(--accent)' }}>{j ? ', ' : ''}{s.title ?? s.path}</a>
                    ))}
                  </div>
                )}
                {t.run && <Steps run={t.run} />}
              </div>
            ))}
            {pending && (
              <div data-testid="agent-approval" style={{ ...CARD, border: '1px solid var(--accent)' }}>
                <div style={{ fontWeight: 600 }}>{pending.req.actor.agentName} demande votre accord</div>
                <div style={{ marginTop: 4 }}>{pending.req.summary}</div>
                <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                  <button data-testid="agent-approve" style={PRIMARY} onClick={() => answer('approved')}>Accepter</button>
                  <button data-testid="agent-refuse" style={BTN} onClick={() => answer('refused')}>Refuser</button>
                </div>
              </div>
            )}
          </div>
          <div style={{ borderTop: '1px solid var(--border)', padding: '8px 12px' }}>
            <select data-testid="assistant-agent" value={agent?.id ?? ''} onChange={e => setAgentId(e.target.value)}
              style={{ width: '100%', padding: 4, borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'inherit', fontSize: 12 }}>
              {usable.map(a => <option key={a.id} value={a.id}>{a.name}{a.description ? ` — ${a.description}` : ''}</option>)}
            </select>
            {agent?.watch && <WatchControl agent={agent} />}
            <textarea data-testid="assistant-input" value={input} disabled={!agent || busy}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }}
              placeholder={agent ? `Demander à ${agent.name}…` : ''}
              style={{ width: '100%', boxSizing: 'border-box', marginTop: 6, minHeight: 54, resize: 'vertical', padding: 6, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text)', font: 'inherit', fontSize: 12 }} />
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              {input.trim() || !agent?.instructions?.trim()
                ? <button data-testid="assistant-send" style={PRIMARY} disabled={!agent || busy || !input.trim()} onClick={() => void send()}>Envoyer</button>
                : <button data-testid="assistant-launch" style={PRIMARY} disabled={busy} title="Lancer l’agent avec ses seules instructions" onClick={() => void send(true)}>▶ Lancer</button>}
              {agent && agentWatch.isWatching(agent.id) && input.trim() && (
                <button data-testid="assistant-add-context" style={BTN} title="Donner ce texte comme contexte à la veille, sans l’arrêter ; il servira aux prochaines relectures de cette note"
                  onClick={() => { if (agentWatch.addContext(agent.id, input)) setInput('') }}>＋ Contexte de la veille</button>
              )}
              {busy && <button style={BTN} onClick={() => abort.current?.abort()}>Arrêter</button>}
              {!busy && turns.length > 0 && <button style={BTN} onClick={() => setTurns([])}>Nouvelle conversation</button>}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function Activity({ userId }: { userId: string }) {
  const [usage, setUsage] = useState<AgentUsageDay[]>([])
  const [approvals, setApprovals] = useState<AgentApproval[]>([])
  const [actions, setActions] = useState<AgentAction[]>([])
  const [agents, setAgents] = useState<AgentDefinition[]>([])
  const [runs, setRuns] = useState(() => listRuns(userId))
  const [error, setError] = useState<string | null>(null)

  const reload = () => {
    const d = agentDirectory()
    if (!d) return
    setRuns(listRuns(userId))
    void d.list().then(setAgents).catch(() => {})
    void d.usage(30).then(setUsage).catch(err => setError(String((err as Error).message)))
    void d.approvals().then(setApprovals).catch(() => {})
    void d.actions(50).then(setActions).catch(() => {})
  }
  useEffect(() => { reload(); return onAgentDirectoryChange(reload) }, [userId])

  const nameOf = (id: string) => agents.find(a => a.id === id)?.name ?? id.slice(0, 8)
  const byAgent = new Map<string, { input: number; output: number; runs: number; calls: number }>()
  for (const u of usage) {
    const row = byAgent.get(u.agentId) ?? { input: 0, output: 0, runs: 0, calls: 0 }
    row.input += u.inputTokens; row.output += u.outputTokens; row.runs += u.runs; row.calls += u.calls
    byAgent.set(u.agentId, row)
  }
  const days = [...new Set(usage.map(u => u.day))].sort().reverse().slice(0, 14)
  const today = new Date().toISOString().slice(0, 10)
  const todayTokens = usage.filter(u => u.day === today).reduce((n, u) => n + u.inputTokens + u.outputTokens, 0)

  const decide = async (a: AgentApproval, approve: boolean) => {
    try { await agentDirectory()?.decide(a.id, approve); reload() } catch (err) { setError((err as Error).message) }
  }

  return (
    <div data-testid="agent-activity" style={{ flex: 1, overflowY: 'auto', padding: '10px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline' }}>
        <div style={{ fontWeight: 600, flex: 1 }}>Consommation</div>
        <button style={{ ...BTN, padding: '1px 6px', fontSize: 11 }} onClick={reload}>Actualiser</button>
      </div>
      <div style={MUTED}>Aujourd’hui : {fmt(todayTokens)} tokens. Les IA externes (ChatGPT…) ne comptent pas leurs tokens ici : seulement leurs appels.</div>
      <table style={{ width: '100%', fontSize: 12, marginTop: 6, borderCollapse: 'collapse' }}>
        <thead><tr style={{ textAlign: 'left', color: 'var(--text-muted)' }}><th>Agent (30 j)</th><th>Entrée</th><th>Sortie</th><th>Exéc.</th><th>Outils</th></tr></thead>
        <tbody>
          {[...byAgent].map(([id, r]) => (
            <tr key={id}><td>{nameOf(id)}</td><td>{fmt(r.input)}</td><td>{fmt(r.output)}</td><td>{r.runs}</td><td>{r.calls}</td></tr>
          ))}
        </tbody>
      </table>
      {days.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 60, marginTop: 8 }} title="Tokens par jour (14 derniers jours)">
          {(() => {
            const totals = days.slice().reverse().map(d => ({ d, n: usage.filter(u => u.day === d).reduce((s, u) => s + u.inputTokens + u.outputTokens, 0) }))
            const max = Math.max(1, ...totals.map(t => t.n))
            return totals.map(t => <div key={t.d} title={`${t.d} : ${fmt(t.n)} tokens`} style={{ flex: 1, height: `${Math.max(2, (t.n / max) * 100)}%`, background: 'var(--accent)', borderRadius: 2, opacity: 0.8 }} />)
          })()}
        </div>
      )}

      <div style={{ fontWeight: 600, marginTop: 16 }}>Accords en attente</div>
      {approvals.filter(a => a.status === 'pending').length === 0 && <div style={MUTED}>Aucun.</div>}
      {approvals.filter(a => a.status === 'pending').map(a => (
        <div key={a.id} data-testid="server-approval" style={CARD}>
          <div><b>{a.agentName}</b> · {new Date(a.createdAt).toLocaleString('fr-FR')}</div>
          <div style={{ marginTop: 4 }}>{a.summary}</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button style={PRIMARY} onClick={() => void decide(a, true)}>Accepter</button>
            <button style={BTN} onClick={() => void decide(a, false)}>Refuser</button>
          </div>
        </div>
      ))}

      <div style={{ display: 'flex', alignItems: 'baseline', marginTop: 16 }}>
        <div style={{ fontWeight: 600, flex: 1 }}>Exécutions sur ce poste</div>
        {runs.length > 0 && <button style={{ ...BTN, padding: '1px 6px', fontSize: 11 }} onClick={() => { clearRuns(userId); setRuns([]) }}>Effacer</button>}
      </div>
      {runs.length === 0 && <div style={MUTED}>Aucune.</div>}
      {runs.slice(0, 20).map(r => (
        <div key={r.id} style={CARD}>
          <div><b>{r.agentName}</b> · {r.status} · {fmt(r.usage.inputTokens + r.usage.outputTokens)} tokens · {r.steps.filter(s => s.kind === 'tool').length} outil(s)
            {r.endedAt ? ` · ${Math.max(0, Math.round((Date.parse(r.endedAt) - Date.parse(r.startedAt)) / 1000))} s` : ''}</div>
          <div style={{ ...MUTED, marginTop: 2 }}>{r.input.slice(0, 160)}</div>
        </div>
      ))}

      <div style={{ fontWeight: 600, marginTop: 16 }}>Actions des IA externes</div>
      {actions.length === 0 && <div style={MUTED}>Aucune.</div>}
      {actions.map(a => (
        <div key={a.id} style={{ ...MUTED, marginTop: 4 }}>
          {new Date(a.createdAt).toLocaleString('fr-FR')} · <b>{a.agentName}</b> · {a.summary} · {a.status}{a.mode !== 'direct' ? ` (${a.mode})` : ''}
        </div>
      ))}
      {error && <div style={{ color: 'var(--danger, #ef4444)', fontSize: 12, marginTop: 8 }}>{error}</div>}
    </div>
  )
}

export class AssistantWidget implements Widget {
  constructor(private readonly manager: WorkspaceManagerImpl, private readonly refs: EditorAreaRefs) {}

  render() {
    return <AssistantPanel manager={this.manager} refs={this.refs} />
  }

  dispose() {}
}
