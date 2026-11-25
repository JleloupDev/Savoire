// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// « Modifications de l'IA » : l'historique des ecritures des agents dans la
// note active, dans le panneau Revision.
//
// Chaque ecriture d'un agent est un point range dans la note elle-meme
// (infrastructure-sync/AiChanges.ts) : qui (l'agent, pour qui), quoi,
// pourquoi. Ici on les liste, du plus recent au plus ancien ; chacun se
// montre dans la note (« Voir ») et s'annule seul (« Annuler »), sans
// toucher a ce qui a ete ecrit depuis. Apres quelques minutes, les points
// d'un meme agent se fondent : la liste se relit de temps en temps.
//
// La section ne montre rien tant que la note n'a aucun point.
import { useEffect, useMemo, useRef, useState } from 'react'
import { agentColor } from '@savoire/agent-core'
import type { IVaultSyncSession } from '@savoire/application'
import type { EditorController } from '@savoire/editor-core'
import type { AiChangeInfo, AiChangeWho, ICRDT } from '@savoire/plugin-api'
import {
  describeAiChange, describeAiChangeSize, describeAiChangeTime, findAiChange, onAiChangeFocus, takeAiChangeFocus,
  type AiChangeFocus,
} from './aiChangeHistory'

/** La liste se relit a ce rythme : le compactage a l'affichage depend de l'heure. */
const REFRESH_MS = 30_000
/** Points montres d'abord ; le reste derriere « Tout afficher ». */
const FIRST_SHOWN = 5
/** Le point demande reste mis en avant ce temps-la. */
const FOCUS_SHOWN_MS = 4000

const SMALL: React.CSSProperties = {
  fontSize: 11, padding: '2px 8px', borderRadius: 4, border: '1px solid var(--border)',
  background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer',
}

export interface AiChangesSectionProps {
  session: IVaultSyncSession
  docId: string
  /** La personne qui annule. */
  me: AiChangeWho
  canWrite: boolean
  /** L'editeur actif (pour « Voir »). */
  editor: () => EditorController | null
}

export function AiChangesSection({ session, docId, me, canWrite, editor }: AiChangesSectionProps) {
  const [crdt, setCrdt] = useState<ICRDT | null>(null)
  const [tick, setTick] = useState(0)
  const [open, setOpen] = useState(true)
  const [all, setAll] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [focus, setFocus] = useState<AiChangeFocus | null>(null)
  const [shownId, setShownId] = useState<string | null>(null)
  const root = useRef<HTMLDivElement | null>(null)

  // La note reste ouverte tant que la section est la (ouvertures comptees par la session).
  useEffect(() => {
    let alive = true
    let doc: ICRDT
    try { doc = session.openDocument(docId) as ICRDT } catch { return }
    setCrdt(doc)
    const refresh = (): void => { if (alive) setTick(t => t + 1) }
    const off = doc.onAiChangesChange?.(refresh)
    // L'etat de la note arrive apres l'ouverture.
    void session.documentLoaded?.(docId).then(refresh, () => undefined)
    const timer = setInterval(refresh, REFRESH_MS)
    return () => {
      alive = false
      off?.()
      clearInterval(timer)
      setCrdt(null)
      // Session deja fermee (changement de vault) : rien a rendre.
      try { session.closeDocument(docId) } catch { /* deja ferme */ }
    }
  }, [session, docId])

  // Une demande « montrer ce point » (carte dans la note, showAiChange).
  useEffect(() => {
    const take = (f: AiChangeFocus | null): void => {
      if (!f || (f.docId && f.docId !== docId)) return
      takeAiChangeFocus(docId)
      setFocus(f)
    }
    take(takeAiChangeFocus(docId))
    return onAiChangeFocus(take)
  }, [docId])

  const list = useMemo<AiChangeInfo[]>(() => {
    try { return crdt?.aiChanges?.() ?? [] } catch { return [] }
  }, [crdt, tick])

  // Le point demande : la section s'ouvre, il vient a l'ecran, et reste marque un instant.
  useEffect(() => {
    if (!focus || !list.length) return
    const target = findAiChange(list, focus.changeId)
    setOpen(true)
    if (target && list.indexOf(target) >= FIRST_SHOWN) setAll(true)
    setShownId(target?.id ?? null)
    setFocus(null)
    requestAnimationFrame(() => {
      const el = target
        ? Array.from(root.current?.querySelectorAll<HTMLElement>('[data-testid="ai-change-item"]') ?? []).find(e => e.dataset.changeId === target.id)
        : root.current
      el?.scrollIntoView({ block: 'nearest' })
    })
  }, [focus, list])
  useEffect(() => {
    if (!shownId) return
    const timer = setTimeout(() => setShownId(null), FOCUS_SHOWN_MS)
    return () => clearTimeout(timer)
  }, [shownId])

  if (!crdt || list.length === 0) return null

  /** Montre dans la note ce que le point a ecrit (ou l'endroit de ce qu'il a retire). */
  function show(c: AiChangeInfo): void {
    setMessage(null)
    const ctrl = editor()
    if (!ctrl?.selectRange || (ctrl.getDocId && ctrl.getDocId() !== docId)) {
      setMessage('Ouvrez la note dans l’éditeur pour voir cette modification.')
      return
    }
    let ranges
    try { ranges = crdt!.aiChangeRanges?.(c.parts) } catch { ranges = undefined }
    const added = ranges?.inserted[0]
    const removed = ranges?.deleted[0]
    if (added) ctrl.selectRange(added.from, added.to)
    else if (removed) ctrl.selectRange(removed.at, removed.at)
    else setMessage('Ce texte n’est plus dans la note.')
  }

  /** Annule ce point, et lui seul. */
  function undo(c: AiChangeInfo): void {
    setMessage(null)
    try {
      const r = crdt!.undoAiChange?.(c.parts, me)
      if (!r) setMessage('Cette note ne sait pas annuler une modification de l’IA.')
      else if (!r.ok) setMessage('Rien à annuler : cette modification l’est déjà.')
      else if (r.partial) setMessage('Annulée en partie : un passage supprimé par l’IA n’a pas pu être remis, son emplacement n’existe plus.')
    } catch (err) {
      setMessage(`Annulation impossible : ${err instanceof Error ? err.message : String(err)}`)
    }
    setTick(t => t + 1)
  }

  const visible = all ? list : list.slice(0, FIRST_SHOWN)
  return (
    <div ref={root} data-testid="ai-changes-section" data-count={list.length} style={{ marginBottom: 12, padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)' }}>
      <button data-testid="ai-changes-toggle" aria-expanded={open} onClick={() => setOpen(v => !v)}
        style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text)', font: 'inherit', fontSize: 12, textAlign: 'left' }}>
        <span style={{ fontWeight: 700, padding: '0 5px', borderRadius: 4, background: 'rgba(124,58,237,0.15)', color: '#7c3aed', fontSize: 11 }}>IA</span>
        <b style={{ flex: 1 }}>Modifications de l’IA</b>
        <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>{list.length} {open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
          {message && <div data-testid="ai-change-message" style={{ fontSize: 12, color: 'var(--text-muted)' }}>{message}</div>}
          {visible.map(c => (
            <Item key={c.id} change={c} canWrite={canWrite} shown={c.id === shownId} onShow={() => show(c)} onUndo={() => undo(c)} />
          ))}
          {list.length > FIRST_SHOWN && (
            <button data-testid="ai-changes-more" onClick={() => setAll(v => !v)} style={{ ...SMALL, alignSelf: 'flex-start' }}>
              {all ? 'Afficher les plus récentes seulement' : `Tout afficher (${list.length})`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function Item({ change: c, canWrite, shown, onShow, onUndo }: { change: AiChangeInfo; canWrite: boolean; shown: boolean; onShow: () => void; onUndo: () => void }) {
  const color = c.agent.color ?? agentColor({ id: c.agent.id })
  return (
    <div
      data-testid="ai-change-item"
      data-change-id={c.id}
      data-agent-id={c.agent.id}
      data-undone={c.undone ? 'true' : 'false'}
      data-focused={shown ? 'true' : 'false'}
      style={{
        padding: 8, borderRadius: 6, border: '1px solid var(--border)', borderLeft: `3px solid ${color}`,
        background: 'var(--bg-surface)', opacity: c.undone ? 0.65 : 1,
        boxShadow: shown ? `0 0 0 2px ${color}` : 'none', transition: 'box-shadow .2s',
      }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'baseline', fontSize: 11, color: 'var(--text-muted)' }}>
        <span data-testid="ai-change-agent" style={{ fontWeight: 700, color }}>{c.agent.name}</span>
        {c.forUser && <span data-testid="ai-change-for">pour {c.forUser.name}</span>}
        <span data-testid="ai-change-time">· {describeAiChangeTime(c)}</span>
      </div>
      <div data-testid="ai-change-summary" style={{ marginTop: 4, fontSize: 12, color: 'var(--text)', textDecoration: c.undone ? 'line-through' : 'none' }}>
        {describeAiChange(c)}
      </div>
      {c.reasons.map((reason, i) => (
        <div key={i} data-testid="ai-change-reason" style={{ marginTop: 2, fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'pre-wrap' }}>
          Pourquoi : {reason}
        </div>
      ))}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 11, color: 'var(--text-faint)' }}>
        <span data-testid="ai-change-size" style={{ flex: 1 }}>{describeAiChangeSize(c)}</span>
        {c.undone ? (
          <span data-testid="ai-change-undone" style={{ color: 'var(--text-muted)' }}>Annulée par {c.undone.by.name}</span>
        ) : (
          <>
            <button data-testid="ai-change-show" onClick={onShow} style={SMALL}>Voir</button>
            {canWrite && <button data-testid="ai-change-undo" onClick={onUndo} style={SMALL}>Annuler</button>}
          </>
        )}
      </div>
    </div>
  )
}
