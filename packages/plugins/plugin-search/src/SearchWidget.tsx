// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Panneau de recherche, sur api.search (ISearchEngine) : pair indexeur en
// profil serveur, index local ailleurs, plein texte des notes ouvertes en
// secours. Voir ADR-027 et plugin-api/search.ts.
//
// - titre et extraits surlignes, titre de section, chemin ;
// - pages suivantes chargees au defilement ;
// - etat de l'index (construction, retard, mode degrade) ;
// - « Tous mes vaults » : recherche globale, resultats groupes par vault.
// Aucun gestionnaire de touches : les raccourcis sont des commandes.
import { useState, useCallback, useEffect, useRef } from 'react'
import type {
  IndexState, ISearchEngine, SearchHighlight, SearchHit, SearchResult, ViewContext, Widget,
} from '@savoire/plugin-api'

/** Taille d'une page de resultats. */
export const SEARCH_PAGE_SIZE = 30
/** Attente apres la derniere frappe. */
const TYPE_DELAY_MS = 200

const T = {
  panel:    { height: '100%', display: 'flex', flexDirection: 'column' as const, fontFamily: 'inherit', color: 'inherit', fontSize: 13 },
  header:   { padding: '8px 10px 6px', borderBottom: '1px solid var(--border, rgba(255,255,255,0.07))', flexShrink: 0 },
  title:    { fontWeight: 600, fontSize: '0.7rem', textTransform: 'uppercase' as const, letterSpacing: '0.08em', color: 'var(--text-faint, #888)', marginBottom: 6 },
  input:    { width: '100%', boxSizing: 'border-box' as const, background: 'var(--bg-elevated, rgba(255,255,255,0.06))', border: '1px solid var(--border, rgba(255,255,255,0.12))', borderRadius: 5, padding: '5px 8px', color: 'inherit', fontSize: 13, outline: 'none' },
  option:   { display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: '0.72rem', color: 'var(--text-muted, #999)', cursor: 'pointer', userSelect: 'none' as const },
  state:    { marginTop: 6, fontSize: '0.7rem', color: 'var(--color-warning, #b45309)', lineHeight: 1.35 },
  body:     { flex: 1, overflow: 'auto', padding: '4px 0' },
  empty:    { padding: '10px 12px', fontSize: '0.75rem', color: 'var(--text-faint, #888)', fontStyle: 'italic' as const },
  count:    { fontSize: '0.65rem', color: 'var(--text-faint, #888)', padding: '4px 12px' },
  vault:    { padding: '8px 12px 3px', fontSize: '0.66rem', fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.07em', color: 'var(--accent, #2dd4bf)' },
  result:   { padding: '6px 12px', cursor: 'pointer', borderBottom: '1px solid var(--border, rgba(255,255,255,0.04))', display: 'block' as const },
  name:     { fontSize: '0.8rem', color: 'var(--text, #cdd6f4)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  path:     { fontSize: '0.65rem', color: 'var(--text-faint, #888)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, marginTop: 1 },
  snippet:  { fontSize: '0.72rem', color: 'var(--text-muted, #aaa)', marginTop: 3, lineHeight: 1.4, overflowWrap: 'anywhere' as const },
  heading:  { fontSize: '0.66rem', color: 'var(--text-faint, #888)', marginRight: 4 },
  mark:     { background: 'var(--accent-dim, rgba(45,212,191,0.25))', color: 'inherit', borderRadius: 2, padding: '0 1px' },
  more:     { padding: '8px 12px', fontSize: '0.7rem', color: 'var(--text-faint, #888)' },
  error:    { padding: '8px 12px', fontSize: '0.72rem', color: 'var(--color-danger, #dc2626)' },
}

/** Texte de l'etat de l'index, ou null s'il est pret. */
export function describeSearchState(state: IndexState): string | null {
  switch (state.status) {
    case 'building': return `Index en construction${state.progress !== undefined ? `, ${Math.round(state.progress * 100)} %` : ''} : résultats partiels.`
    case 'lagging': return 'Index en retard : les dernières modifications arrivent.'
    case 'unavailable': return 'Recherche limitée aux notes ouvertes (index complet indisponible).'
    default: return null
  }
}

/** Texte avec des passages surlignes (positions dans ce texte). */
function Highlighted({ text, ranges }: { text: string; ranges?: SearchHighlight[] }) {
  if (!ranges || ranges.length === 0) return <>{text}</>
  const parts: React.ReactNode[] = []
  let pos = 0
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  sorted.forEach((r, i) => {
    const start = Math.max(pos, Math.min(r.start, text.length))
    const end = Math.max(start, Math.min(r.end, text.length))
    if (start > pos) parts.push(text.slice(pos, start))
    if (end > start) parts.push(<mark key={i} style={T.mark}>{text.slice(start, end)}</mark>)
    pos = end
  })
  if (pos < text.length) parts.push(text.slice(pos))
  return <>{parts}</>
}

function folderOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i > 0 ? path.slice(0, i) : ''
}

function HitRow({ hit, onOpen }: { hit: SearchHit; onOpen: (hit: SearchHit) => void }) {
  const [hover, setHover] = useState(false)
  const folder = folderOf(hit.path)
  return (
    <div
      data-testid="search-hit"
      data-id={hit.id}
      style={{ ...T.result, background: hover ? 'var(--bg-hover, rgba(255,255,255,0.05))' : 'transparent' }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => onOpen(hit)}
      title={hit.path}
    >
      <div style={T.name} data-testid="search-hit-title"><Highlighted text={hit.title} ranges={hit.titleHighlights} /></div>
      {folder && <div style={T.path}>{folder}</div>}
      {hit.snippets.map((s, i) => (
        <div key={i} style={T.snippet} data-testid="search-snippet">
          {/* Titre de section : en tete de l'extrait s'il y est deja, sinon ajoute. */}
          {s.heading && (s.text.startsWith(s.heading)
            ? <span style={T.heading}>§</span>
            : <span style={T.heading}>§ {s.heading} ·</span>)}
          <Highlighted text={s.text} ranges={s.highlights} />
        </div>
      ))}
    </div>
  )
}

interface Shared {
  /** Bascule « Tous mes vaults » demandee par une commande (panneau monte). */
  onGlobal?: (on: boolean) => void
  /** Meme demande, avant que le panneau soit monte. */
  wantGlobal?: boolean
}

export function SearchPanel({ ctx, engine, shared }: { ctx: ViewContext; engine: ISearchEngine; shared: Shared }) {
  const [text, setText] = useState('')
  const [all, setAll] = useState(() => {
    const want = !!shared.wantGlobal && !!engine.global
    shared.wantGlobal = false
    return want
  })
  const [result, setResult] = useState<SearchResult | null>(null)
  const [hits, setHits] = useState<SearchHit[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [state, setState] = useState<IndexState>(() => engine.state())
  const [, setVaultTick] = useState(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const ctrl = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const loadingMore = useRef(false)
  const global = all ? engine.global : undefined

  useEffect(() => engine.onStateChange(s => setState(s)), [engine])

  const run = useCallback((q: string, everywhere: boolean) => {
    // Une recherche lancee annule celle qui attendait la fin de la frappe.
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    ctrl.current?.abort()
    const gen = ++generation.current
    setError(null)
    if (!q.trim()) { setResult(null); setHits([]); setLoading(false); return }
    const c = new AbortController()
    ctrl.current = c
    setLoading(true)
    const g = everywhere ? engine.global : undefined
    const p = g ? g.search({ text: q, limit: SEARCH_PAGE_SIZE }, { signal: c.signal }) : engine.search({ text: q, limit: SEARCH_PAGE_SIZE }, { signal: c.signal })
    p.then(r => {
      if (gen !== generation.current) return
      setResult(r)
      setHits(r.hits)
    }, err => {
      if (gen !== generation.current || c.signal.aborted) return
      setResult(null)
      setHits([])
      setError(err instanceof Error ? err.message : String((err as { message?: string })?.message ?? err))
    }).finally(() => { if (gen === generation.current) setLoading(false) })
  }, [engine])

  const schedule = useCallback((q: string, everywhere: boolean) => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => run(q, everywhere), TYPE_DELAY_MS)
  }, [run])

  // Autre vault ouvert : la recherche porte sur lui (et la recherche globale peut disparaitre).
  useEffect(() => ctx.workspace.subscribeVaultChange?.(() => {
    setVaultTick(t => t + 1)
    if (text.trim()) schedule(text, all)
  }), [ctx, schedule, text, all])

  // Commande « Tous mes vaults ».
  useEffect(() => {
    shared.onGlobal = wanted => {
      shared.wantGlobal = false
      const on = wanted && !!engine.global
      setAll(on)
      if (text.trim()) run(text, on)
    }
    return () => { shared.onGlobal = undefined }
  }, [shared, run, text, engine])

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
    ctrl.current?.abort()
  }, [])

  /** Page suivante, quand on arrive en bas. */
  const loadMore = useCallback(() => {
    const r = result
    if (!r?.next || loadingMore.current) return
    loadingMore.current = true
    const gen = generation.current
    const c = ctrl.current ?? new AbortController()
    const g = all ? engine.global : undefined
    const q = { text, limit: SEARCH_PAGE_SIZE, cursor: r.next }
    const p = g ? g.search(q, { signal: c.signal }) : engine.search(q, { signal: c.signal })
    p.then(next => {
      if (gen !== generation.current) return
      setResult(next)
      setHits(prev => {
        const seen = new Set(prev.map(h => `${h.vaultId ?? ''}|${h.id}`))
        return [...prev, ...next.hits.filter(h => !seen.has(`${h.vaultId ?? ''}|${h.id}`))]
      })
    }, err => {
      if (gen !== generation.current) return
      setError(err instanceof Error ? err.message : String(err))
    }).finally(() => { loadingMore.current = false })
  }, [result, all, engine, text])

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80) loadMore()
  }, [loadMore])

  const open = useCallback((hit: SearchHit) => {
    if (all && global && hit.vaultId) void global.open(hit).catch(err => setError(err instanceof Error ? err.message : String(err)))
    else if (hit.path) void ctx.workspace.openFile(hit.path)
  }, [all, global, ctx])

  // Recherche globale : groupes par vault, dans l'ordre de leur meilleur resultat.
  const groups: { key: string; name: string; hits: SearchHit[] }[] = []
  if (all) {
    const byVault = new Map<string, { key: string; name: string; hits: SearchHit[] }>()
    for (const h of hits) {
      const key = h.vaultId ?? ''
      let g = byVault.get(key)
      if (!g) { g = { key, name: h.vaultName ?? (key || 'Vault'), hits: [] }; byVault.set(key, g); groups.push(g) }
      g.hits.push(h)
    }
  }

  const stateText = all ? null : describeSearchState(state)
  const canAll = !!engine.global

  return (
    <div style={T.panel} data-testid="search-panel">
      <div style={T.header}>
        <div style={T.title}>Recherche</div>
        <input
          autoFocus
          data-testid="search-input"
          style={T.input}
          placeholder={all ? 'Rechercher dans tous mes vaults…' : 'Rechercher dans le vault…'}
          value={text}
          onChange={e => { setText(e.target.value); schedule(e.target.value, all) }}
          spellCheck={false}
        />
        {canAll && (
          <label style={T.option} title="Chercher dans tous les vaults que vous pouvez lire">
            <input
              type="checkbox"
              data-testid="search-all-vaults"
              checked={all}
              onChange={e => { setAll(e.target.checked); if (text.trim()) run(text, e.target.checked) }}
            />
            Tous mes vaults
          </label>
        )}
        {stateText && <div style={T.state} data-testid="search-state" title="État de l'index de ce vault">{stateText}</div>}
        {all && result?.partial && <div style={T.state} data-testid="search-partial">Certains vaults n'ont pas répondu : résultats incomplets.</div>}
      </div>

      <div style={T.body} onScroll={onScroll} data-testid="search-results">
        {!text.trim() && <div style={T.empty}>Tapez pour rechercher {all ? 'dans tous vos vaults' : 'dans tout le vault'}.</div>}
        {error && <div style={T.error} data-testid="search-error">{error}</div>}
        {text.trim() && !error && result && hits.length === 0 && !loading && (
          <div style={T.empty}>Aucun résultat pour « {text.trim()} ».</div>
        )}
        {hits.length > 0 && result && (
          <div style={T.count} data-testid="search-count">{result.total} résultat{result.total > 1 ? 's' : ''}</div>
        )}
        {all
          ? groups.map(g => (
            <div key={g.key} data-testid="search-vault-group" data-vault={g.key}>
              <div style={T.vault}>{g.name}</div>
              {g.hits.map(h => <HitRow key={`${g.key}|${h.id}`} hit={h} onOpen={open} />)}
            </div>
          ))
          : hits.map(h => <HitRow key={h.id} hit={h} onOpen={open} />)}
        {result?.next && <div style={T.more} data-testid="search-more">Faites défiler pour voir la suite…</div>}
      </div>
    </div>
  )
}

export class SearchWidget implements Widget {
  constructor(
    private readonly ctx: ViewContext,
    private readonly engine: ISearchEngine,
    private readonly shared: Shared = {},
  ) {}

  render() {
    return <SearchPanel ctx={this.ctx} engine={this.engine} shared={this.shared} />
  }

  dispose(): void {}
}
