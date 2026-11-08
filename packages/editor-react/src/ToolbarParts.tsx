// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Briques communes a la barre du haut et a la bulle de selection : bouton de
// commande, bouton a menu, menu (liste ou palette de couleurs).

import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { EditorCommandContext, ToolbarCommand } from '@savoire/plugin-api'
import type { EditorController } from '@savoire/editor-core'
import { useEditorContext } from './EditorContext'
import { EditorIcon } from './IconContext'

export const ICON_SIZE = 17

/** Contexte passe aux commandes : l'editeur de ce panneau. */
export function commandContext(ctrl: EditorController | null): EditorCommandContext {
  if (!ctrl) return {}
  return ctrl.getCommandContext?.() ?? { view: (ctrl as unknown as { view?: unknown }).view }
}

/** Redessine a chaque deplacement du curseur ou frappe (une fois par image). */
export function useEditorTick(ctrl: EditorController | null): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!ctrl) return
    let frame = 0
    const bump = () => {
      if (frame) return
      frame = requestAnimationFrame(() => { frame = 0; setTick(t => t + 1) })
    }
    const offs = [ctrl.on('selectionChanged', bump), ctrl.on('documentChanged', bump), ctrl.on('pluginLoaded', bump)]
    return () => { offs.forEach(off => off()); if (frame) cancelAnimationFrame(frame) }
  }, [ctrl])
  return tick
}

/** « Gras (Ctrl+B) » : le libelle et le raccourci en vigueur. */
export function useCommandTitle(): (cmd: ToolbarCommand) => string {
  const ctrl = useEditorContext()
  return (cmd) => {
    const hint = hotkeyOf(ctrl, cmd)
    return hint ? `${cmd.label} (${hint})` : cmd.label
  }
}

function hotkeyOf(ctrl: EditorController | null, cmd: ToolbarCommand): string | null {
  return cmd.commandId ? ctrl?.describeHotkey?.(cmd.commandId) ?? null : null
}

function safe<T>(fn: (() => T) | undefined, fallback: T): T {
  if (!fn) return fallback
  try { return fn() } catch { return fallback }
}

export function isActive(cmd: ToolbarCommand, ctx: EditorCommandContext): boolean {
  return safe(cmd.isActive ? () => cmd.isActive!(ctx) : undefined, false)
}

function isEnabled(cmd: ToolbarCommand, ctx: EditorCommandContext): boolean {
  return safe(cmd.isEnabled ? () => cmd.isEnabled!(ctx) : undefined, true)
}

export function runCommand(cmd: ToolbarCommand, ctx: EditorCommandContext): void {
  try { cmd.run(ctx) } catch (err) { console.error(`[barre] ${cmd.id}`, err) }
}

// ── Bouton simple ────────────────────────────────────────────────────────────

export function CommandButton({ cmd, ctx, testId, onRun }: {
  cmd: ToolbarCommand
  ctx: EditorCommandContext
  testId: string
  onRun?: () => void
}) {
  const titleOf = useCommandTitle()
  const toggles = !!cmd.isActive
  return (
    <button
      type="button"
      className="sv-tb-btn"
      title={titleOf(cmd)}
      aria-label={cmd.label}
      aria-pressed={toggles ? isActive(cmd, ctx) : undefined}
      disabled={!isEnabled(cmd, ctx)}
      data-testid={testId}
      data-command-id={cmd.id}
      // mousedown, pas click : l'editeur garde le focus et la selection.
      onMouseDown={e => { e.preventDefault(); runCommand(cmd, ctx); onRun?.() }}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); runCommand(cmd, ctx); onRun?.() } }}
    >
      <EditorIcon name={cmd.icon} size={ICON_SIZE} />
    </button>
  )
}

// ── Menu deroulant ───────────────────────────────────────────────────────────

/** Un menu ouvert a la fois par barre ; ferme au clic dehors ou a Echap. */
export function useMenuState() {
  const [open, setOpen] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(null)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(null) }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])
  return { open, setOpen, rootRef, toggle: (id: string) => setOpen(o => (o === id ? null : id)) }
}

export function MenuButton({ id, title, icon, text, className, testId, commandId, open, onToggle, align, up, chevron = true, children }: {
  id: string
  title: string
  icon?: string
  /** Texte a la place (ou a cote) de l'icone : « Titre 1 », « Insérer ». */
  text?: string | null
  className?: string
  testId: string
  commandId?: string
  open: boolean
  onToggle: (id: string) => void
  align?: 'left' | 'right'
  up?: boolean
  chevron?: boolean
  children: ReactNode
}) {
  return (
    <span className="sv-tb-wrap">
      <button
        type="button"
        className={`sv-tb-btn ${className ?? ''}`}
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={testId}
        data-command-id={commandId}
        onMouseDown={e => { e.preventDefault(); onToggle(id) }}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') { e.preventDefault(); onToggle(id) } }}
      >
        {icon && <EditorIcon name={icon} size={ICON_SIZE} />}
        {text && <span>{text}</span>}
        {chevron && <EditorIconChevron />}
      </button>
      {open && (
        <div
          role="menu"
          className={`sv-tb-menu${align === 'right' ? ' sv-tb-menu-right' : ''}${up ? ' sv-tb-menu-up' : ''}`}
          onMouseDown={e => e.preventDefault()}
        >
          {children}
        </div>
      )}
    </span>
  )
}

function EditorIconChevron() {
  return <span className="sv-tb-chev" style={{ display: 'inline-flex' }}><EditorIcon name="chevron-down" size={13} /></span>
}

/** Contenu d'un menu : les sous-commandes, en liste ou en palette. */
export function CommandItems({ items, layout, ctx, testId, onDone, onRun }: {
  items: ToolbarCommand[]
  layout?: 'list' | 'palette'
  ctx: EditorCommandContext
  testId: string
  onDone: () => void
  /** Remplace l'execution par defaut (retenir la couleur choisie...). */
  onRun?: (sub: ToolbarCommand) => void
}) {
  const ctrl = useEditorContext()
  const titleOf = useCommandTitle()
  const run = (sub: ToolbarCommand) => {
    if (onRun) onRun(sub)
    else { runCommand(sub, ctx); onDone() }
  }

  if (layout === 'palette') {
    const plain = items.filter(i => !i.swatch)
    const colored = items.filter(i => i.swatch)
    return (
      <>
        <div className="sv-tb-palette">
          {colored.map(sub => (
            <button
              key={sub.id} type="button" role="menuitemradio" className="sv-tb-swatch"
              title={titleOf(sub)} aria-label={sub.label} aria-checked={isActive(sub, ctx)}
              data-testid={testId} data-command-id={sub.id}
              style={swatchStyle(sub)}
              onMouseDown={e => { e.preventDefault(); run(sub) }}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); run(sub) } }}
            >
              A
            </button>
          ))}
        </div>
        {plain.length > 0 && <div className="sv-tb-rule" />}
        {plain.map(sub => <MenuItem key={sub.id} cmd={sub} ctx={ctx} testId={testId} onRun={() => run(sub)} hotkey={hotkeyOf(ctrl, sub)} />)}
      </>
    )
  }
  return <>{items.map(sub => <MenuItem key={sub.id} cmd={sub} ctx={ctx} testId={testId} onRun={() => run(sub)} hotkey={hotkeyOf(ctrl, sub)} />)}</>
}

// Surlignage : la pastille a le fond colore. Couleur du texte : la lettre.
function swatchStyle(cmd: ToolbarCommand): React.CSSProperties {
  return cmd.icon === 'baseline' ? { color: cmd.swatch } : { background: cmd.swatch }
}

export function MenuItem({ cmd, ctx, testId, onRun, hotkey }: {
  cmd: ToolbarCommand
  ctx: EditorCommandContext
  testId: string
  onRun: () => void
  hotkey?: string | null
}) {
  const heading = /^heading-([1-3])$/.exec(cmd.icon)
  return (
    <button
      type="button"
      role={cmd.isActive ? 'menuitemradio' : 'menuitem'}
      className="sv-tb-item"
      aria-checked={cmd.isActive ? isActive(cmd, ctx) : undefined}
      disabled={!isEnabled(cmd, ctx)}
      data-testid={testId}
      data-command-id={cmd.id}
      onMouseDown={e => { e.preventDefault(); onRun() }}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRun() } }}
    >
      <EditorIcon name={cmd.icon} size={16} />
      <span className={heading ? `sv-tb-h${heading[1]}` : undefined}>{cmd.label}</span>
      {hotkey && <kbd>{hotkey}</kbd>}
    </button>
  )
}
