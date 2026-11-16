// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Page Admin → Retours : les retours des testeurs (bulle de l'application),
// leurs captures, et leur analyse par l'IA de l'administrateur.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from './AuthContext'
import { aiService, setAIAccount } from './aiService'
import { feedbackAdminApi, type FeedbackReport } from './feedback'
import { SimpleFeedbackAnalyzer, type FeedbackAnalysis, type FeedbackAnalyzer } from './feedbackAnalysis'

const BTN: React.CSSProperties = {
  padding: '3px 10px', background: 'var(--bg-elevated)', color: 'var(--text)',
  border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontSize: '0.72rem', cursor: 'pointer',
}
const PRIMARY: React.CSSProperties = { ...BTN, background: 'var(--accent)', border: '1px solid var(--accent)', color: 'var(--accent-text, #fff)', fontWeight: 600 }
const CARD: React.CSSProperties = {
  background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 8,
  padding: 18, display: 'flex', flexDirection: 'column', gap: 10, boxShadow: 'var(--shadow)',
}
const SECTION_TITLE: React.CSSProperties = {
  margin: 0, fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.08em',
}
const PRIORITY: Record<string, { label: string; color: string }> = {
  high: { label: 'Prioritaire', color: 'var(--color-danger)' },
  medium: { label: 'Moyen', color: 'var(--color-warning, #d97706)' },
  low: { label: 'Faible', color: 'var(--text-faint)' },
}

function parseContext(json: string): Record<string, unknown> {
  try { return JSON.parse(json) as Record<string, unknown> } catch { return {} }
}

export function FeedbackAdmin() {
  const { token, activeAccount } = useAuth()
  const [reports, setReports] = useState<FeedbackReport[]>([])
  const [showArchived, setShowArchived] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [shots, setShots] = useState<Record<string, string>>({})
  const [zoom, setZoom] = useState<string | null>(null)
  const [analysis, setAnalysis] = useState<FeedbackAnalysis | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [analysisError, setAnalysisError] = useState<string | null>(null)
  const [highlight, setHighlight] = useState<Set<string>>(new Set())

  // L'IA est celle du compte connecte (ses connexions, sur ce poste).
  setAIAccount(activeAccount?.userId)
  const hasAI = aiService.connections().length > 0
  const analyzer: FeedbackAnalyzer = useMemo(() => new SimpleFeedbackAnalyzer(req => aiService.chat(req)), [])

  const load = useCallback(async () => {
    if (!token) return
    setError(null)
    try { setReports(await feedbackAdminApi.list(token, showArchived)) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [token, showArchived])

  useEffect(() => { void load() }, [load])

  // Les captures chargees sont liberees en quittant la page.
  const shotsRef = useRef(shots)
  shotsRef.current = shots
  useEffect(() => () => { Object.values(shotsRef.current).forEach(u => URL.revokeObjectURL(u)) }, [])

  async function showShot(id: string) {
    if (!token) return
    if (shots[id]) { setZoom(shots[id]); return }
    try {
      const url = await feedbackAdminApi.screenshotUrl(token, id)
      setShots(s => ({ ...s, [id]: url }))
      setZoom(url)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function act(fn: () => Promise<void>) {
    try { await fn(); await load() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function analyze() {
    setAnalyzing(true)
    setAnalysisError(null)
    try { setAnalysis(await analyzer.analyze(reports.filter(r => !r.archivedAt))) }
    catch (e) { setAnalysisError(e instanceof Error ? e.message : String(e)) }
    finally { setAnalyzing(false) }
  }

  const open = reports.filter(r => !r.archivedAt)

  return (
    <div style={{ display: 'flex', flex: 1, overflow: 'hidden', padding: 16, gap: 16 }}>

      {/* ── Analyse ── */}
      <div style={{ ...CARD, width: 380, minWidth: 320, flexShrink: 0, overflowY: 'auto', alignSelf: 'stretch' }}>
        <h3 style={SECTION_TITLE}>Analyse par l'IA</h3>
        <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
          Les {open.length} retours non rangés partent à votre connexion IA (messages et contexte, pas les captures).
        </div>
        {hasAI ? (
          <button onClick={analyze} disabled={analyzing || open.length === 0} data-testid="feedback-analyze"
            style={{ ...PRIMARY, alignSelf: 'flex-start', opacity: analyzing || open.length === 0 ? 0.6 : 1 }}>
            {analyzing ? 'Analyse en cours…' : 'Analyser'}
          </button>
        ) : (
          <div style={{ fontSize: '0.78rem', color: 'var(--text-faint)' }}>
            Aucune connexion IA sur ce poste. Ajoutez-en une dans Paramètres → IA.
          </div>
        )}
        {analysisError && <div style={{ color: 'var(--color-danger)', fontSize: '0.78rem' }}>{analysisError}</div>}

        {analysis && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: '0.82rem', lineHeight: 1.5 }}>
            <div style={{ fontSize: '0.68rem', color: 'var(--text-faint)' }}>
              {analysis.analyzedCount} retours · {analysis.connection} · {analysis.model}
            </div>
            {analysis.raw !== undefined ? (
              <pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: '0.78rem' }}>{analysis.raw}</pre>
            ) : (
              <>
                {analysis.summary && <div>{analysis.summary}</div>}
                {analysis.themes.map((th, i) => (
                  <div key={i} onClick={() => setHighlight(new Set(th.reportIds))} title="Montrer les retours de ce thème"
                    style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '8px 10px', cursor: 'pointer', background: 'var(--bg-base)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <strong>{th.title}</strong>
                      <span style={{ fontSize: '0.62rem', fontWeight: 700, color: PRIORITY[th.priority].color }}>{PRIORITY[th.priority].label}</span>
                      <span style={{ fontSize: '0.62rem', color: 'var(--text-faint)' }}>{th.reportIds.length} retour{th.reportIds.length > 1 ? 's' : ''}</span>
                    </div>
                    {th.description && <div style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>{th.description}</div>}
                  </div>
                ))}
                {analysis.suggestions.length > 0 && (
                  <div>
                    <h3 style={SECTION_TITLE}>Suggestions</h3>
                    <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                      {analysis.suggestions.map((s, i) => <li key={i}>{s}</li>)}
                    </ul>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* ── Liste des retours ── */}
      <div style={{ ...CARD, flex: 1, overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <h3 style={SECTION_TITLE}>Retours ({reports.length})</h3>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {highlight.size > 0 && <button onClick={() => setHighlight(new Set())} style={BTN}>Tout montrer</button>}
            <label style={{ fontSize: '0.72rem', color: 'var(--text-muted)', display: 'flex', gap: 4, alignItems: 'center' }}>
              <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />
              Avec les rangés
            </label>
            <button onClick={load} style={BTN}>Rafraîchir</button>
          </div>
        </div>

        {error && <div style={{ color: 'var(--color-danger)', fontSize: '0.8rem' }}>{error}</div>}
        {reports.length === 0 && !error && <div style={{ color: 'var(--text-faint)', fontSize: '0.8rem' }}>Aucun retour pour l'instant.</div>}

        {reports.filter(r => highlight.size === 0 || highlight.has(r.id)).map(r => {
          const ctx = parseContext(r.context)
          return (
            <div key={r.id} data-testid="feedback-report" style={{
              display: 'flex', gap: 12, padding: '10px 14px', background: 'var(--bg-base)',
              borderRadius: 'var(--radius)', border: '1px solid var(--border)', opacity: r.archivedAt ? 0.6 : 1,
            }}>
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                  <strong style={{ color: 'var(--text)' }}>{r.userName ?? r.userId}</strong>
                  {r.userEmail && ` · ${r.userEmail}`} · {new Date(r.createdAt).toLocaleString('fr-FR')}
                  {r.archivedAt && ' · rangé'}
                </div>
                <div style={{ fontSize: '0.86rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{r.message}</div>
                <details style={{ fontSize: '0.68rem', color: 'var(--text-faint)' }}>
                  <summary style={{ cursor: 'pointer' }}>
                    {[ctx.platform, ctx.viewport, ctx.title].filter(Boolean).join(' · ') || 'Contexte'}
                  </summary>
                  <pre style={{ whiteSpace: 'pre-wrap', margin: '4px 0 0' }}>{JSON.stringify(ctx, null, 2)}{r.userAgent ? `\n${r.userAgent}` : ''}</pre>
                </details>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0, alignItems: 'flex-end' }}>
                {r.hasScreenshot && (
                  shots[r.id]
                    ? <img src={shots[r.id]} alt="Capture" onClick={() => setZoom(shots[r.id])}
                        style={{ width: 120, height: 75, objectFit: 'cover', borderRadius: 4, border: '1px solid var(--border)', cursor: 'zoom-in' }} />
                    : <button onClick={() => showShot(r.id)} style={BTN}>Voir la capture</button>
                )}
                <button onClick={() => token && act(() => feedbackAdminApi.setArchived(token, r.id, !r.archivedAt))} style={BTN}>
                  {r.archivedAt ? 'Remettre' : 'Ranger'}
                </button>
                <button onClick={() => token && confirm('Supprimer ce retour ?') && act(() => feedbackAdminApi.remove(token, r.id))}
                  style={{ ...BTN, color: 'var(--color-danger)' }}>Supprimer</button>
              </div>
            </div>
          )
        })}
      </div>

      {zoom && (
        <div onClick={() => setZoom(null)} style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 9500,
          display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out', padding: 24,
        }}>
          <img src={zoom} alt="Capture" style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: 6 }} />
        </div>
      )}
    </div>
  )
}
