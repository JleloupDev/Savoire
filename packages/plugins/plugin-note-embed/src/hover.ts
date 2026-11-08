// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Apercu d'un lien survole, comme dans Obsidian : la souris reste sur un lien
// [[...]] d'une note (0,8 s par defaut, reglable dans les Reglages), une
// fenetre montre la note visee, ou son titre, ou son bloc (#^verset). On peut
// y entrer pour la faire defiler ; elle se ferme quand la souris s'en va,
// au clic ailleurs, a la molette hors d'elle ou sur Echap.
//
// Les liens rendus portent leur cible dans l'adresse : `#Page`, `#Page#Titre`,
// `#Page#^bloc` (plugin-wikilinks).
import { createIcon } from '@savoire/plugin-api'
import type { PluginAPI } from '@savoire/plugin-api'
import { parseSubpath, type EmbedSubpath } from './section'

/** Delai par defaut avant l'apercu (ms), sans reglage de l'hote. */
export const DEFAULT_PREVIEW_DELAY = 800
/** Grace laissee pour passer du lien a la fenetre (ms). */
const LEAVE_GRACE_MS = 300
// Assez large pour un tableau ou un board, sans depasser l'ecran.
const MAX_WIDTH = 720
const MAX_HEIGHT = 520

/** Cible d'une adresse de lien rendu. null : pas un lien de note. */
export function previewTargetOf(href: string): { page: string; subpath: EmbedSubpath | null } | null {
  if (!href.startsWith('#')) return null
  let raw = href.slice(1)
  try { raw = decodeURIComponent(raw) } catch { /* garde tel quel */ }
  const at = raw.indexOf('#')
  const page = (at < 0 ? raw : raw.slice(0, at)).trim()
  if (!page) return null
  return { page, subpath: at < 0 ? null : parseSubpath(raw.slice(at + 1)) }
}

export type RenderPart = (body: HTMLElement, path: string, subpath: EmbedSubpath | null) => Promise<void>

/** Branche l'apercu sur le document. Rend la fonction qui le debranche. */
export function installLinkPreview(api: PluginAPI, render: RenderPart): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let leaveTimer: ReturnType<typeof setTimeout> | null = null
  let anchor: Element | null = null
  let popup: HTMLDivElement | null = null

  const delay = () => {
    const d = api.workspace?.linkPreviewDelay?.()
    return typeof d === 'number' && d >= 0 ? d : DEFAULT_PREVIEW_DELAY
  }
  const clearTimers = () => {
    if (timer) { clearTimeout(timer); timer = null }
    if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = null }
  }
  const close = () => {
    clearTimers()
    popup?.remove()
    popup = null
    anchor = null
  }

  const show = (a: Element) => {
    const target = previewTargetOf(a.getAttribute('href') ?? '')
    if (!target || !a.isConnected) return
    popup?.remove()
    const box = document.createElement('div')
    box.className = 'link-preview'
    box.dataset.testid = 'link-preview'
    const r = a.getBoundingClientRect()
    const WIDTH = Math.max(280, Math.min(MAX_WIDTH, window.innerWidth - 16))
    const below = window.innerHeight - r.bottom > MAX_HEIGHT + 16 || r.top < MAX_HEIGHT + 16
    const left = Math.max(8, Math.min(r.left, window.innerWidth - WIDTH - 8))
    box.style.cssText = [
      'position:fixed', `left:${left}px`,
      below ? `top:${r.bottom + 6}px` : `bottom:${window.innerHeight - r.top + 6}px`,
      `width:${WIDTH}px`, `max-height:${MAX_HEIGHT}px`, 'overflow:auto', 'z-index:9999',
      'padding:10px 14px', 'border-radius:8px', 'font-size:13px', 'line-height:1.5',
      'background:var(--bg-elevated,#fff)', 'color:var(--text,#222)',
      'border:1px solid var(--border,#ddd)', 'box-shadow:0 8px 28px rgba(0,0,0,0.25)',
    ].join(';')
    const head = document.createElement('div')
    head.style.cssText = 'font-size:11px;color:var(--text-faint,#999);margin-bottom:6px;display:flex;align-items:center;gap:6px'
    head.append(createIcon(api.icons, 'file-text', { size: 13 }))
    head.append(`${target.page}${target.subpath ? ` › ${target.subpath.kind === 'block' ? `^${target.subpath.id}` : target.subpath.headings.join(' › ')}` : ''}`)
    const body = document.createElement('div')
    body.className = 'link-preview-body'
    body.textContent = '…'
    box.append(head, body)
    box.addEventListener('mouseenter', () => { if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = null } })
    box.addEventListener('mouseleave', () => scheduleLeave())
    document.body.appendChild(box)
    popup = box
    void render(body, target.page, target.subpath)
  }

  const scheduleLeave = () => {
    if (timer) { clearTimeout(timer); timer = null }
    if (!popup) { anchor = null; return }
    if (leaveTimer) clearTimeout(leaveTimer)
    leaveTimer = setTimeout(close, LEAVE_GRACE_MS)
  }

  /** Un lien de note survolable : dans une note, ou dans l'apercu lui-meme. */
  const linkAt = (el: EventTarget | null): Element | null => {
    const a = (el as Element | null)?.closest?.('a[href^="#"]')
    if (!a || !(a.closest('.cm-editor') || a.closest('.link-preview'))) return null
    return previewTargetOf(a.getAttribute('href') ?? '') ? a : null
  }

  const onOver = (e: MouseEvent) => {
    const a = linkAt(e.target)
    if (!a || a === anchor) return
    const wait = delay()
    if (wait <= 0) return
    if (timer) clearTimeout(timer)
    anchor = a
    // Un lien dans l'apercu ouvre un nouvel apercu a sa place.
    timer = setTimeout(() => { timer = null; if (anchor === a) show(a) }, wait)
  }
  const onOut = (e: MouseEvent) => {
    const a = linkAt(e.target)
    if (!a || a !== anchor) return
    // Encore dans le lien (passage sur un enfant) : rien.
    if (e.relatedTarget instanceof Node && a.contains(e.relatedTarget)) return
    scheduleLeave()
  }
  const onDown = (e: MouseEvent) => {
    if (popup && e.target instanceof Node && popup.contains(e.target)) {
      // Un lien de l'apercu ouvre sa note : l'apercu s'efface derriere.
      if ((e.target as Element).closest?.('a')) setTimeout(close, 0)
      return
    }
    close()
  }
  const onWheel = (e: WheelEvent) => {
    if (popup && e.target instanceof Node && popup.contains(e.target)) return
    if (popup || timer) close()
  }
  const onKey = () => { if (popup || timer) close() }

  document.addEventListener('mouseover', onOver, true)
  document.addEventListener('mouseout', onOut, true)
  document.addEventListener('mousedown', onDown, true)
  document.addEventListener('wheel', onWheel, { capture: true, passive: true })
  document.addEventListener('keydown', onKey, true)
  return () => {
    close()
    document.removeEventListener('mouseover', onOver, true)
    document.removeEventListener('mouseout', onOut, true)
    document.removeEventListener('mousedown', onDown, true)
    document.removeEventListener('wheel', onWheel, true)
    document.removeEventListener('keydown', onKey, true)
  }
}
