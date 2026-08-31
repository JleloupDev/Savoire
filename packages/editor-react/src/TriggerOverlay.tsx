// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// TriggerOverlay — generic floating overlay for any InputTrigger with a TriggerHandler.
// Replaces SlashMenu — it reads the active trigger from ctrl.getActiveTrigger()
// and calls trigger.handler.getItems() to populate items.

import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useEditorContext } from './EditorContext'
import type { TriggerItem, TriggerActivation } from '@savoire/plugin-api'

// ── Helpers ───────────────────────────────────────────────────────────────────

function getInsert(item: TriggerItem, query: string): string {
  if (typeof item.insert === 'function') return item.insert(query)
  return item.insert
}

function groupByCategory(items: TriggerItem[]): { category: string; entries: TriggerItem[] }[] {
  const map = new Map<string, TriggerItem[]>()
  for (const item of items) {
    const cat = item.category ?? 'Autre'
    if (!map.has(cat)) map.set(cat, [])
    map.get(cat)!.push(item)
  }
  return [...map.entries()].map(([category, entries]) => ({ category, entries }))
}

// ── Component ─────────────────────────────────────────────────────────────────

export function TriggerOverlay() {
  const ctrl = useEditorContext()
  const [activation, setActivation] = useState<TriggerActivation | null>(null)
  const [items, setItems] = useState<TriggerItem[]>([])
  const [selectedIdx, setSelectedIdx] = useState(0)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!ctrl) return

    function refresh() {
      const act = ctrl!.getActiveTrigger()
      setActivation(act)
      setSelectedIdx(0)
      if (!act) { setItems([]); return }

      // Resolve handler from pluginAPI via the controller — use internal cast
      const core = ctrl as unknown as { pluginAPI: { triggers: { getAll(): import('@savoire/plugin-api').InputTrigger[] } } }
      const trigger = core.pluginAPI?.triggers?.getAll().find(t => t.id === act.triggerId)
      const handler = trigger?.handler
      if (handler) {
        setItems(handler.getItems(act.query))
      } else {
        setItems([])
      }
    }

    const unsubDoc = ctrl.on('documentChanged', refresh)
    const unsubSel = ctrl.on('selectionChanged', () => {
      const act = ctrl.getActiveTrigger()
      if (!act) { setActivation(null); setItems([]) }
    })
    return () => { unsubDoc(); unsubSel() }
  }, [ctrl])

  // Ordre de navigation = ordre AFFICHE.
  //
  // groupByCategory() regroupe les entrees d'une meme categorie, ce qui
  // reordonne la liste des qu'une categorie n'est pas contigue dans `items`.
  // Les fleches indexaient `items`, l'oeil suivait l'affichage : le
  // surlignage sautait des lignes, puis remontait au milieu une fois le bas
  // atteint. On navigue donc sur la liste aplatie DANS L'ORDRE DU RENDU.
  const grouped = groupByCategory(items)
  const flat = grouped.flatMap(g => g.entries)

  // La liste peut retrecir sous le curseur (l'utilisateur affine sa requete).
  useEffect(() => {
    if (selectedIdx >= flat.length) setSelectedIdx(0)
  }, [flat.length, selectedIdx])

  useEffect(() => {
    if (!activation || !ctrl || flat.length === 0) return

    function onKey(e: KeyboardEvent) {
      if (e.key === 'ArrowDown') {
        e.preventDefault(); e.stopPropagation()
        setSelectedIdx(i => (i + 1) % flat.length)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation()
        setSelectedIdx(i => (i - 1 + flat.length) % flat.length)
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        const item = flat[selectedIdx]
        if (item) { e.preventDefault(); e.stopPropagation(); commit(item) }
      } else if (e.key === 'Escape') {
        setActivation(null); setItems([])
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [activation, selectedIdx, flat, ctrl])

  // Defilement CONFINE au menu. scrollIntoView() fait defiler tous les
  // ancetres scrollables, fenetre comprise : sur un curseur proche du bas de
  // l'ecran, il deplacait la page sous un menu en position fixed.
  useEffect(() => {
    const menu = menuRef.current
    const el = menu?.querySelector('[data-selected="true"]') as HTMLElement | null
    if (!menu || !el) return
    const top = el.offsetTop - menu.offsetTop
    const bottom = top + el.offsetHeight
    if (top < menu.scrollTop) menu.scrollTop = top
    else if (bottom > menu.scrollTop + menu.clientHeight) menu.scrollTop = bottom - menu.clientHeight
  }, [selectedIdx])

  if (!activation || !ctrl || flat.length === 0) return null

  function commit(item: TriggerItem) {
    if (!ctrl || !activation) return

    // Resolve handler for optional onCommit callback
    const core = ctrl as unknown as { pluginAPI: { triggers: { getAll(): import('@savoire/plugin-api').InputTrigger[] } } }
    const trigger = core.pluginAPI?.triggers?.getAll().find(t => t.id === activation.triggerId)
    const handler = trigger?.handler

    const insert = getInsert(item, activation.query)
    if (handler?.onCommit) {
      handler.onCommit(activation, item)
    } else {
      ctrl.commitTriggerInsert(activation.from, activation.character.length, activation.query, insert)
    }
    setActivation(null)
    setItems([])
  }

  const menuWidth = 280
  const menuMaxHeight = 300
  const left = Math.min(activation.coords.x, window.innerWidth - menuWidth - 8)
  const enoughRoomAbove = activation.lineTop > menuMaxHeight + 8
  // see ADR-024
  return createPortal(
    <div
      ref={menuRef}
      style={{
        position: 'fixed',
        left: Math.max(4, left),
        ...(enoughRoomAbove
          ? { bottom: Math.max(4, window.innerHeight - activation.lineTop + 4) }
          : { top: Math.max(4, activation.coords.y + 4) }),
        width: menuWidth,
        maxHeight: menuMaxHeight,
        overflowY: 'auto',
        background: 'var(--bg-elevated, #1e1e2e)',
        border: '1px solid var(--border, #444)',
        borderRadius: 8,
        boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
        zIndex: 9998,
        fontSize: '0.82rem',
      }}
      onMouseDown={e => e.preventDefault()}
    >
      {grouped.map(({ category, entries }) => (
        <div key={category}>
          <div style={{ padding: '6px 10px 2px', fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-faint, #666)' }}>
            {category}
          </div>
          {entries.map(item => {
            const idx = flat.indexOf(item)
            const active = idx === selectedIdx
            return (
              <div
                key={item.id}
                data-selected={active}
                onClick={() => commit(item)}
                onMouseEnter={() => setSelectedIdx(idx)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '5px 10px', cursor: 'pointer',
                  background: active ? 'var(--accent-dim, rgba(139,92,246,0.15))' : 'transparent',
                  color: active ? 'var(--accent, #8b5cf6)' : 'var(--text, #ddd)',
                  borderRadius: 4, margin: '0 4px',
                }}
              >
                <span style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-surface, #252535)', borderRadius: 5, fontSize: '0.72rem', fontWeight: 700, flexShrink: 0, color: 'var(--text-muted, #aaa)' }}>
                  {item.icon ?? item.label[0]}
                </span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {item.label}
                  </div>
                  {item.description && (
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-faint, #777)', marginTop: 1 }}>
                      {item.description}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      ))}
    </div>,
    document.body,
  )
}
