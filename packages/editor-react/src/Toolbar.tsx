// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Barre d'edition, au-dessus du document. Rendue depuis le REGISTRE des
// commandes (api.toolbar) : un plugin y ajoute ses boutons, dans son groupe,
// ou dans les menus « Insérer » et « ⋯ » (champ `menu`).
//
//  - Le premier bouton montre le style du paragraphe sous le curseur.
//  - Les boutons a bascule s'allument (gras, liste...).
//  - Bouton a menu (surlignage, couleur) : un clic applique la derniere
//    couleur choisie, la fleche ouvre la palette.
//  - Barre etroite : les derniers groupes passent dans « ⋯ ».

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { EditorCommandContext, ToolbarCommand } from '@savoire/plugin-api'
import { useEditorContext } from './EditorContext'
import { EditorIcon } from './IconContext'
import { ensureToolbarStyles } from './toolbarStyles'
import {
  CommandButton, CommandItems, ICON_SIZE, MenuButton, MenuItem, commandContext, isActive, runCommand,
  useCommandTitle, useEditorTick, useMenuState,
} from './ToolbarParts'

export { useCommandTitle } from './ToolbarParts'

/** Ordre des groupes. Les groupes inconnus (plugins) suivent. */
const GROUP_ORDER = ['bloc', 'format', 'liste', 'insert']
/** Groupes jamais replies : style du paragraphe et mise en forme. */
const KEPT = 2

// Largeurs (px) pour decider du repli, sans mesurer chaque bouton.
const W_BUTTON = 32
const W_SPLIT = 47
const W_BLOCK = 116
const W_SEP = 13
const W_INSERT = 104
const W_MORE = 34
const PADDING = 24

function widthOf(cmd: ToolbarCommand): number {
  if (!cmd.items?.length) return W_BUTTON
  return cmd.currentLabel ? W_BLOCK : W_SPLIT
}

export interface ToolbarProps {
  /** Ajoute « Masquer la barre » au menu ⋯. */
  onHide?: () => void
}

export function Toolbar({ onHide }: ToolbarProps = {}) {
  ensureToolbarStyles()
  const ctrl = useEditorContext()
  useEditorTick(ctrl)
  const ctx = commandContext(ctrl)
  const menus = useMenuState()
  const barRef = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(Number.POSITIVE_INFINITY)
  // Derniere couleur choisie, par bouton a palette.
  const [lastUsed, setLastUsed] = useState<Record<string, string>>({})

  useLayoutEffect(() => {
    const el = barRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(entries => setWidth(entries[0]?.contentRect.width ?? el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // Le menu ouvert se ferme quand on change de note.
  useEffect(() => { menus.setOpen(null) }, [ctrl]) // eslint-disable-line react-hooks/exhaustive-deps

  const commands = ctrl?.getToolbarCommands?.() ?? []
  if (commands.length === 0) return <div className="sv-tb" ref={barRef} />

  const insertCmds = commands.filter(c => c.menu === 'insert')
  const moreCmds = commands.filter(c => c.menu === 'more')
  const groups = new Map<string, ToolbarCommand[]>()
  for (const cmd of commands) {
    if (cmd.menu) continue
    const g = cmd.group ?? 'autre'
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g)!.push(cmd)
  }
  const ordered = [
    ...GROUP_ORDER.filter(g => groups.has(g)),
    ...[...groups.keys()].filter(g => !GROUP_ORDER.includes(g)),
  ]

  // Repli : on garde les groupes tant qu'ils tiennent, le reste va dans ⋯.
  const insertInline = insertCmds.length > 0 && width >= 560
  let budget = width - PADDING - W_MORE - (insertInline ? W_INSERT : 0)
  const visible: string[] = []
  const folded: string[] = []
  for (const [i, g] of ordered.entries()) {
    const w = groups.get(g)!.reduce((sum, c) => sum + widthOf(c), 0) + (i > 0 ? W_SEP : 0)
    if (folded.length === 0 && (i < KEPT || w <= budget)) { visible.push(g); budget -= w } else folded.push(g)
  }
  const foldedCmds = folded.flatMap(g => groups.get(g)!)
  const showMore = moreCmds.length > 0 || foldedCmds.length > 0 || !insertInline && insertCmds.length > 0 || !!onHide

  const close = () => menus.setOpen(null)
  const runSub = (parent: ToolbarCommand, sub: ToolbarCommand) => {
    runCommand(sub, ctx)
    if (parent.itemsLayout === 'palette') setLastUsed(m => ({ ...m, [parent.id]: sub.id }))
    close()
  }

  return (
    <div className="sv-tb" ref={barRef} role="toolbar" aria-label="Mise en forme" data-testid="editor-toolbar">
      <div ref={menus.rootRef} style={{ display: 'contents' }}>
        {visible.map((g, i) => (
          <span key={g} style={{ display: 'contents' }}>
            {i > 0 && <span className="sv-tb-sep" />}
            {groups.get(g)!.map(cmd => cmd.items?.length
              ? <Dropdown key={cmd.id} cmd={cmd} ctx={ctx} menus={menus} lastUsed={lastUsed[cmd.id]} onRunSub={runSub} />
              : <CommandButton key={cmd.id} cmd={cmd} ctx={ctx} testId="toolbar-command" />)}
          </span>
        ))}
        {insertInline && (
          <>
            <span className="sv-tb-sep" />
            <MenuButton
              id="__insert" title="Insérer" icon="plus" text="Insérer" className="sv-tb-labelled"
              testId="toolbar-insert" open={menus.open === '__insert'} onToggle={menus.toggle}
            >
              <CommandItems items={insertCmds} ctx={ctx} testId="toolbar-command" onDone={close} />
            </MenuButton>
          </>
        )}
        <span className="sv-tb-spacer" />
        {showMore && (
          <MenuButton
            id="__more" title="Plus d'options" icon="ellipsis" testId="toolbar-more" align="right" chevron={false}
            open={menus.open === '__more'} onToggle={menus.toggle}
          >
            {foldedCmds.map(cmd => cmd.items?.length
              ? (
                <div key={cmd.id}>
                  <div className="sv-tb-title">{cmd.label}</div>
                  <CommandItems items={cmd.items} layout={cmd.itemsLayout} ctx={ctx} testId="toolbar-command" onDone={close} />
                </div>
              )
              : <MenuItem key={cmd.id} cmd={cmd} ctx={ctx} testId="toolbar-command" onRun={() => { runCommand(cmd, ctx); close() }} />)}
            {!insertInline && insertCmds.length > 0 && (
              <>
                {foldedCmds.length > 0 && <div className="sv-tb-rule" />}
                <div className="sv-tb-title">Insérer</div>
                <CommandItems items={insertCmds} ctx={ctx} testId="toolbar-command" onDone={close} />
              </>
            )}
            {(foldedCmds.length > 0 || (!insertInline && insertCmds.length > 0)) && moreCmds.length > 0 && <div className="sv-tb-rule" />}
            <CommandItems items={moreCmds} ctx={ctx} testId="toolbar-command" onDone={close} />
            {onHide && (
              <>
                <div className="sv-tb-rule" />
                <button type="button" role="menuitem" className="sv-tb-item" data-testid="toolbar-hide"
                  onMouseDown={e => { e.preventDefault(); close(); onHide() }}>
                  <EditorIcon name="eye-off" size={16} />
                  <span>Masquer la barre</span>
                </button>
              </>
            )}
          </MenuButton>
        )}
      </div>
    </div>
  )
}

type Menus = ReturnType<typeof useMenuState>

/**
 * Bouton a menu. Style du paragraphe : tout le bouton ouvre le menu et
 * montre le style en cours. Sinon (surlignage, couleur, menus de plugins) :
 * l'icone applique, la fleche ouvre.
 */
export function Dropdown({ cmd, ctx, menus, lastUsed, onRunSub, compact }: {
  cmd: ToolbarCommand
  ctx: EditorCommandContext
  menus: Menus
  lastUsed?: string
  onRunSub: (parent: ToolbarCommand, sub: ToolbarCommand) => void
  /** Dans la bulle : boutons plus serres. */
  compact?: boolean
}) {
  const titleOf = useCommandTitle()
  const open = menus.open === cmd.id
  const items = cmd.items ?? []
  const testId = compact ? 'bubble-command' : 'toolbar-command'
  const menu = (
    <div role="menu" className="sv-tb-menu" onMouseDown={e => e.preventDefault()}>
      {cmd.itemsLayout === 'palette' && <div className="sv-tb-title">{cmd.label}</div>}
      <CommandItems
        items={items} layout={cmd.itemsLayout} ctx={ctx} testId={testId}
        onDone={() => menus.setOpen(null)} onRun={sub => onRunSub(cmd, sub)}
      />
    </div>
  )

  if (cmd.currentLabel) {
    const label = (() => { try { return cmd.currentLabel!(ctx) } catch { return null } })() ?? cmd.label
    return (
      <span className="sv-tb-wrap">
        <button
          type="button" className="sv-tb-btn sv-tb-block" title={cmd.label} aria-label={`${cmd.label} : ${label}`}
          aria-haspopup="menu" aria-expanded={open} data-testid={testId} data-command-id={cmd.id}
          onMouseDown={e => { e.preventDefault(); menus.toggle(cmd.id) }}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') { e.preventDefault(); menus.toggle(cmd.id) } }}
        >
          <span>{label}</span>
          <span className="sv-tb-chev" style={{ display: 'inline-flex' }}><EditorIcon name="chevron-down" size={13} /></span>
        </button>
        {open && menu}
      </span>
    )
  }

  const last = items.find(i => i.id === lastUsed)
  const swatch = last?.swatch
  return (
    <span className="sv-tb-wrap">
      <button
        type="button" className="sv-tb-btn" title={titleOf(last ?? cmd)} aria-label={last?.label ?? cmd.label}
        aria-pressed={cmd.isActive ? isActive(cmd, ctx) : undefined}
        data-testid={testId} data-command-id={cmd.id}
        style={{ paddingRight: 2, borderTopRightRadius: 0, borderBottomRightRadius: 0, minWidth: compact ? 26 : 28 }}
        onMouseDown={e => { e.preventDefault(); if (last) onRunSub(cmd, last); else runCommand(cmd, ctx) }}
      >
        <EditorIcon name={cmd.icon} size={ICON_SIZE} />
        {swatch && <span aria-hidden style={{ position: 'absolute', left: 7, right: 5, bottom: 4, height: 3, borderRadius: 2, background: swatch }} />}
      </button>
      <button
        type="button" className="sv-tb-btn" title={`${cmd.label} : choisir`} aria-label={`${cmd.label} : choisir`}
        aria-haspopup="menu" aria-expanded={open} data-testid={`${testId}-menu`} data-command-id={cmd.id}
        style={{ minWidth: 16, width: 16, padding: 0, borderTopLeftRadius: 0, borderBottomLeftRadius: 0 }}
        onMouseDown={e => { e.preventDefault(); menus.toggle(cmd.id) }}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') { e.preventDefault(); menus.toggle(cmd.id) } }}
      >
        <span className="sv-tb-chev" style={{ display: 'inline-flex' }}><EditorIcon name="chevron-down" size={13} /></span>
      </button>
      {open && menu}
    </span>
  )
}
