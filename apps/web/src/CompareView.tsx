// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// L'ecran « Comparer » de la Revision : deux etats d'un document (actuel et
// propose), affiches par la vraie vue du plugin, en lecture seule.
//
//  - Cote a cote : actuel a gauche, propose a droite ;
//  - Rideau      : les deux superposes, une poignee decouvre l'un sous l'autre ;
//  - Alterner    : Espace bascule entre avant et apres ;
//  - Differences : la liste des elements changes, et la vue des differences
//                  si le plugin sait la produire (review.diffContent).
//
// Generique : chaque etat est ouvert par FileTypeSpec.open, avec un contexte
// sans arbre ni texte partage, dont ctx.vault rend le contenu de cet etat.
// Un plugin n'a rien a ecrire de plus ; il peut decrire ses differences
// (review.diff) et les colorier (review.diffContent).
import { useEffect, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { DiffItem, FileTypeSpec, FileView, VaultAPI } from '@savoire/plugin-api'

export type CompareMode = 'side' | 'curtain' | 'toggle' | 'diff'

export interface CompareOptions {
  path: string
  spec: FileTypeSpec
  before: string
  after: string
  /** Titre (« Proposition de Bob »). */
  title?: string
  onAccept?(): Promise<void> | void
  onReject?(): Promise<void> | void
}

/** Un VaultAPI qui ne connait qu'un document : celui de cet etat, en lecture. */
function stateVault(path: string, raw: string): VaultAPI {
  const read = async (p: string) => (p === path ? raw : '')
  return new Proxy({} as VaultAPI, {
    get(_t, k) {
      if (k === 'readDocumentByPath' || k === 'read') return read
      if (k === 'list') return async () => [path]
      if (k === 'resolveDocumentId') return () => undefined
      if (k === 'getVaultId') return () => ''
      return undefined
    },
  })
}

/** Monte la vue du plugin sur un etat. */
function StatePane({ spec, path, raw, label, style }: { spec: FileTypeSpec; path: string; raw: string; label: string; style?: React.CSSProperties }) {
  const box = useRef<HTMLDivElement | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const el = box.current
    if (!el || !spec.open) return
    let view: FileView | null = null
    try {
      view = spec.open(path, { vaultId: '', path, readOnly: true, vault: stateVault(path, raw) })
      view.mount(el)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    return () => { try { view?.destroy() } catch { /* deja demonte */ } el.replaceChildren() }
  }, [spec, path, raw])
  return (
    <div data-testid="compare-pane" data-state={label} style={{ position: 'relative', minWidth: 0, minHeight: 0, isolation: 'isolate', ...style }}>
      <div ref={box} style={{ position: 'absolute', inset: 0 }} />
      {error && <div style={{ position: 'absolute', inset: 0, padding: 16, color: 'var(--danger, #ef4444)' }}>Affichage impossible : {error}</div>}
    </div>
  )
}

const CHANGE_LABEL: Record<DiffItem['change'], string> = { added: 'Ajouté', removed: 'Retiré', modified: 'Modifié', moved: 'Déplacé' }
const CHANGE_COLOR: Record<DiffItem['change'], string> = { added: '#16a34a', removed: '#ef4444', modified: '#d97706', moved: '#2563eb' }

function Tag({ children, color }: { children: React.ReactNode; color: string }) {
  return <span style={{ position: 'absolute', top: 8, left: 60, zIndex: 2, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: color, color: 'white', pointerEvents: 'none' }}>{children}</span>
}

export function CompareScreen({ opts, onClose }: { opts: CompareOptions; onClose(): void }) {
  const { spec, path, before, after } = opts
  const [mode, setMode] = useState<CompareMode>('side')
  const [showAfter, setShowAfter] = useState(true)
  const [curtain, setCurtain] = useState(50)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const diffs = (() => { try { return spec.review?.diff?.(before, after) ?? null } catch { return null } })()
  const diffRaw = (() => { try { return spec.review?.diffContent?.(before, after) ?? null } catch { return null } })()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === ' ' && mode === 'toggle') { e.preventDefault(); setShowAfter(v => !v) }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [mode, onClose])

  async function decide(action?: () => Promise<void> | void) {
    if (!action) return
    setBusy(true); setError(null)
    try { await action(); onClose() } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }

  const tab = (m: CompareMode, label: string) => (
    <button data-testid={`compare-mode-${m}`} onClick={() => setMode(m)}
      style={{ fontSize: 12, padding: '4px 10px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border)', background: mode === m ? 'var(--accent)' : 'transparent', color: mode === m ? 'white' : 'var(--text-muted)', fontWeight: 600 }}>
      {label}
    </button>
  )

  return (
    <div data-testid="compare-screen" data-mode={mode} style={{ position: 'fixed', inset: 0, zIndex: 5000, display: 'flex', flexDirection: 'column', background: 'var(--bg-surface, #ffffff)', color: 'var(--text, #1f2937)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
        <div style={{ fontWeight: 700, marginRight: 8 }}>{opts.title ?? 'Comparer'} <span style={{ fontWeight: 400, color: 'var(--text-faint)' }}>· {path}</span></div>
        {tab('side', 'Côte à côte')}
        {tab('curtain', 'Rideau')}
        {tab('toggle', 'Alterner')}
        {tab('diff', `Différences${diffs ? ` (${diffs.length})` : ''}`)}
        {mode === 'curtain' && (
          <input data-testid="compare-curtain" type="range" min={0} max={100} value={curtain} onChange={e => setCurtain(Number(e.target.value))}
            aria-label="Position du rideau" title="Glisser pour découvrir l’état proposé" style={{ width: 220, marginLeft: 8 }} />
        )}
        <div style={{ flex: 1 }} />
        {error && <span style={{ color: 'var(--danger, #ef4444)', fontSize: 12 }}>{error}</span>}
        {opts.onAccept && <button data-testid="compare-accept" disabled={busy} onClick={() => void decide(opts.onAccept)} style={{ fontSize: 12, padding: '4px 12px', borderRadius: 6, border: 'none', background: '#16a34a', color: 'white', fontWeight: 600, cursor: 'pointer' }}>Accepter</button>}
        {opts.onReject && <button data-testid="compare-reject" disabled={busy} onClick={() => void decide(opts.onReject)} style={{ fontSize: 12, padding: '4px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', fontWeight: 600, cursor: 'pointer' }}>Refuser</button>}
        <button data-testid="compare-close" onClick={onClose} title="Fermer (Échap)" style={{ fontSize: 16, padding: '0 8px', border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}>✕</button>
      </div>

      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {mode === 'side' && (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2, background: 'var(--border)' }}>
            <div style={{ position: 'relative', background: 'var(--bg-base, var(--bg-surface, #ffffff))' }}><Tag color="#64748b">Actuel</Tag><StatePane spec={spec} path={path} raw={before} label="before" style={{ position: 'absolute', inset: 0 }} /></div>
            <div style={{ position: 'relative', background: 'var(--bg-base, var(--bg-surface, #ffffff))' }}><Tag color="#16a34a">Proposé</Tag><StatePane spec={spec} path={path} raw={after} label="after" style={{ position: 'absolute', inset: 0 }} /></div>
          </div>
        )}

        {mode === 'curtain' && (
          <div style={{ position: 'absolute', inset: 0 }}>
            <StatePane spec={spec} path={path} raw={before} label="before" style={{ position: 'absolute', inset: 0 }} />
            {/* Le cadre coupe ce qui depasse ; la vue garde sa taille et sa place. */}
            <div style={{ position: 'absolute', top: 0, bottom: 0, right: 0, left: `${curtain}%`, overflow: 'hidden', zIndex: 1 }}>
              <StatePane spec={spec} path={path} raw={after} label="after" style={{ position: 'absolute', top: 0, bottom: 0, left: `${-curtain / (1 - Math.min(curtain, 99.9) / 100)}%`, width: `${100 / (1 - Math.min(curtain, 99.9) / 100)}%` }} />
            </div>
            <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${curtain}%`, width: 2, background: 'var(--accent, #7c3aed)', pointerEvents: 'none', zIndex: 3 }} />
            <Tag color="#64748b">Actuel</Tag>
            <span style={{ position: 'absolute', top: 8, right: 60, zIndex: 2, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: '#16a34a', color: 'white' }}>Proposé</span>
          </div>
        )}

        {mode === 'toggle' && (
          <div style={{ position: 'absolute', inset: 0 }}>
            <StatePane spec={spec} path={path} raw={before} label="before" style={{ position: 'absolute', inset: 0, visibility: showAfter ? 'hidden' : 'visible' }} />
            <StatePane spec={spec} path={path} raw={after} label="after" style={{ position: 'absolute', inset: 0, visibility: showAfter ? 'visible' : 'hidden' }} />
            <Tag color={showAfter ? '#16a34a' : '#64748b'}>{showAfter ? 'Proposé' : 'Actuel'}</Tag>
            <button data-testid="compare-toggle" data-showing={showAfter ? 'after' : 'before'} onClick={() => setShowAfter(v => !v)}
              style={{ position: 'absolute', bottom: 14, left: '50%', transform: 'translateX(-50%)', zIndex: 4, fontSize: 12, padding: '6px 14px', borderRadius: 16, border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text)', cursor: 'pointer' }}>
              Basculer (Espace)
            </button>
          </div>
        )}

        {mode === 'diff' && (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', gridTemplateColumns: diffRaw ? '280px 1fr' : '1fr' }}>
            <div data-testid="compare-diff-list" style={{ overflowY: 'auto', padding: 12, borderRight: '1px solid var(--border)', fontSize: 12 }}>
              {!diffs && <div style={{ color: 'var(--text-faint)' }}>Ce type de document ne décrit pas ses différences. Utilisez le rideau ou l’alternance.</div>}
              {diffs?.length === 0 && <div style={{ color: 'var(--text-faint)' }}>Aucune différence.</div>}
              {diffs?.map(d => (
                <div key={d.id + d.change} data-testid="compare-diff-item" data-change={d.change} style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '4px 0' }}>
                  <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 8, color: 'white', background: CHANGE_COLOR[d.change] }}>{CHANGE_LABEL[d.change]}</span>
                  <span>{d.label ?? d.id}</span>
                </div>
              ))}
            </div>
            {diffRaw && <StatePane spec={spec} path={path} raw={diffRaw} label="diff" />}
          </div>
        )}
      </div>
    </div>
  )
}

let host: { el: HTMLElement; root: Root } | null = null

/** Ouvre l'ecran Comparer (un seul a la fois). */
export function openCompare(opts: CompareOptions): void {
  closeCompare()
  const el = document.createElement('div')
  document.body.appendChild(el)
  const root = createRoot(el)
  host = { el, root }
  root.render(<CompareScreen opts={opts} onClose={closeCompare} />)
}

export function closeCompare(): void {
  if (!host) return
  const { el, root } = host
  host = null
  root.unmount()
  el.remove()
}
