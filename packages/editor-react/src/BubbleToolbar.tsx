// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Bulle de mise en forme, au-dessus d'une selection. Elle ne montre que les
// commandes marquees `bubble` (ce qui s'applique a un bout de texte), pas
// toute la barre.
//
//  - Elle apparait quand on relache la souris, pas pendant la selection.
//  - Au-dessus de la selection, ou dessous s'il n'y a pas la place.
//  - Elle disparait quand l'editeur perd le focus. See ADR-024.

import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ToolbarCommand } from '@savoire/plugin-api'
import { useEditorContext } from './EditorContext'
import { ensureToolbarStyles } from './toolbarStyles'
import { Dropdown } from './Toolbar'
import { CommandButton, commandContext, runCommand, useEditorTick, useMenuState } from './ToolbarParts'

const GAP = 8
const MARGIN = 8

// Ordre des groupes dans la bulle ; les commentaires a la fin.
const BUBBLE_ORDER = ['bloc', 'format', 'liste', 'insert']
function rankOf(cmd: ToolbarCommand): number {
  const g = cmd.group ?? cmd.menu ?? ''
  if (g === 'review') return 100
  const i = BUBBLE_ORDER.indexOf(g)
  return i === -1 ? 50 : i
}

type Anchor = { x: number; top: number; bottom: number }

/** L'editeur CodeMirror derriere le controleur, sans en dependre. */
function viewOf(ctx: { view?: unknown }): { hasFocus: boolean; dom: HTMLElement } | null {
  const v = ctx.view as { hasFocus?: boolean; dom?: unknown } | undefined
  return v && v.dom instanceof HTMLElement ? (v as { hasFocus: boolean; dom: HTMLElement }) : null
}

export function BubbleToolbar() {
  ensureToolbarStyles()
  const ctrl = useEditorContext()
  useEditorTick(ctrl)
  const menus = useMenuState()
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null)
  const pointerDown = useRef(false)
  const bubbleRef = useRef<HTMLDivElement | null>(null)
  const [lastUsed, setLastUsed] = useState<Record<string, string>>({})

  const refresh = useCallback(() => {
    if (!ctrl) return
    const view = viewOf(commandContext(ctrl))
    const text = ctrl.getSelectionText()
    const sel = text.length > 0 && !pointerDown.current && (view?.hasFocus ?? true) ? ctrl.getSelectionCoords() : null
    if (!sel) { setAnchor(null); menus.setOpen(null); return }
    setAnchor({ x: sel.x, top: sel.y, bottom: sel.bottom ?? sel.y + 20 })
  }, [ctrl]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!ctrl) return
    const offSel = ctrl.on('selectionChanged', refresh)
    const onDown = (e: MouseEvent) => {
      if (bubbleRef.current?.contains(e.target as Node)) return
      pointerDown.current = true
      setAnchor(null)
    }
    const onUp = () => {
      if (!pointerDown.current) return
      pointerDown.current = false
      // Laisse CodeMirror poser la selection avant de la lire.
      setTimeout(refresh, 0)
    }
    const onScroll = () => refresh()
    const view = viewOf(commandContext(ctrl))
    const onBlur = (e: FocusEvent) => {
      if (bubbleRef.current?.contains(e.relatedTarget as Node)) return
      setAnchor(null)
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('mouseup', onUp, true)
    window.addEventListener('scroll', onScroll, true)
    view?.dom.addEventListener('focusout', onBlur)
    view?.dom.addEventListener('focusin', refresh)
    return () => {
      offSel()
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('mouseup', onUp, true)
      window.removeEventListener('scroll', onScroll, true)
      view?.dom.removeEventListener('focusout', onBlur)
      view?.dom.removeEventListener('focusin', refresh)
    }
  }, [ctrl, refresh])

  // Placement apres mesure : centree, dans l'ecran, dessus sinon dessous.
  useLayoutEffect(() => {
    const el = bubbleRef.current
    if (!anchor || !el) { setPlace(null); return }
    const { width, height } = el.getBoundingClientRect()
    const left = Math.min(Math.max(MARGIN, anchor.x - width / 2), window.innerWidth - width - MARGIN)
    const above = anchor.top - GAP - height
    const top = above >= MARGIN ? above : anchor.bottom + GAP
    setPlace(p => (p && p.left === left && p.top === top ? p : { left, top }))
  }, [anchor, menus.open])

  if (!ctrl || !anchor) return null
  const ctx = commandContext(ctrl)
  const cmds = ctrl.getToolbarCommands().filter(c => c.bubble)
    .map((c, i) => ({ c, i, rank: rankOf(c) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map(x => x.c)
  if (cmds.length === 0) return null

  const runSub = (parent: ToolbarCommand, sub: ToolbarCommand) => {
    runCommand(sub, ctx)
    if (parent.itemsLayout === 'palette') setLastUsed(m => ({ ...m, [parent.id]: sub.id }))
    menus.setOpen(null)
  }

  return createPortal(
    <div
      ref={el => { bubbleRef.current = el; menus.rootRef.current = el }}
      className="sv-bubble"
      role="toolbar"
      aria-label="Mise en forme de la sélection"
      data-testid="bubble-toolbar"
      style={place ? { left: place.left, top: place.top } : { left: -9999, top: -9999, visibility: 'hidden' }}
      onMouseDown={e => e.preventDefault()}
    >
      {cmds.map((cmd, i) => (
        <Fragment key={cmd.id}>
          {i > 0 && (cmds[i - 1].group ?? cmds[i - 1].menu) !== (cmd.group ?? cmd.menu) && <span className="sv-tb-sep" />}
          {cmd.items?.length
            ? <Dropdown cmd={cmd} ctx={ctx} menus={menus} lastUsed={lastUsed[cmd.id]} onRunSub={runSub} compact />
            : <CommandButton cmd={cmd} ctx={ctx} testId="bubble-command" />}
        </Fragment>
      ))}
    </div>,
    document.body,
  )
}
