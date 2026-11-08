// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Board integre dans une note : ![[Tableau de bord.board]]. Meme iframe
// isolee et meme API que dans son fichier ; sa hauteur suit son contenu.
import { createIcon } from '@savoire/plugin-api'
import { BLOCK_DESTROY_EVENT } from '@savoire/plugin-api'
import type { PluginAPI } from '@savoire/plugin-api'
import { confirmIn } from './confirm'
import { BoardHost } from './host'
import { ensureStyle } from './style'

export const BOARD_EMBED_RE = /^\s*!\[\[([^\]|#]+\.board)(?:\|[^\]]*)?\]\]\s*$/i

/** Hauteur d'un board integre : entre ces bornes, selon son contenu. */
export const EMBED_MIN_HEIGHT = 40
export const EMBED_MAX_HEIGHT = 1600

export function parseBoardEmbed(text: string): string | null {
  const m = BOARD_EMBED_RE.exec(text)
  return m ? m[1].trim() : null
}

/** Le board : chemin exact, sinon par son nom (comme un lien [[...]]). */
async function resolveBoard(api: PluginAPI, name: string): Promise<{ id: string; path: string } | null> {
  const direct = api.vault.resolveDocumentId(name)
  if (direct) return { id: direct, path: name }
  const all = await api.vault.list().catch(() => [] as string[])
  const lower = name.toLowerCase()
  const path = all.find(p => p.toLowerCase() === lower) ?? all.find(p => p.toLowerCase().endsWith(`/${lower}`))
  const id = path ? api.vault.resolveDocumentId(path) : undefined
  return path && id ? { id, path } : null
}

export function renderBoardEmbed(name: string, api: PluginAPI | undefined): HTMLElement {
  ensureStyle()
  const el = document.createElement('div')
  el.className = 'board-embed'
  el.dataset.testid = 'board-embed'
  // Un lien ou un bouton du cadre ne fait pas entrer l'editeur dans le bloc.
  el.addEventListener('mousedown', e => { if ((e.target as HTMLElement).closest?.('a, button')) e.stopPropagation() })
  const fail = (msg: string) => {
    const m = document.createElement('div')
    m.className = 'board-embed-foot board-status-bad'
    m.dataset.testid = 'board-embed-error'
    m.textContent = `⚠ ${msg}`
    el.replaceChildren(m)
  }
  if (!api) { fail('Aucun vault ouvert.'); return el }
  let host: BoardHost | null = null
  let dead = false
  el.addEventListener(BLOCK_DESTROY_EVENT, () => { dead = true; host?.dispose(); host = null }, { once: true })

  void resolveBoard(api, name).then(async board => {
    if (!board) { fail(`Board introuvable : « ${name} »`); return }
    const status = document.createElement('span')
    status.dataset.testid = 'board-embed-status'
    const open = document.createElement('a')
    open.href = '#'
    open.style.cssText = 'display:inline-flex;align-items:center;gap:5px'
    open.append(createIcon(api.icons, 'layout-dashboard', { size: 13 }), board.path.split('/').pop() ?? '')
    open.title = `Ouvrir ${board.path}`
    open.addEventListener('click', e => { e.preventDefault(); void api.workspace.openFile(board.path) })
    const again = document.createElement('a')
    again.href = '#'
    again.append(createIcon(api.icons, 'refresh-cw', { size: 13 }))
    again.title = 'Relire et relancer le board'
    const foot = document.createElement('div')
    foot.className = 'board-embed-foot'
    foot.append(open, again, status)
    const run = async () => {
      if (dead) return
      status.textContent = ''
      const source = await api.vault.read(board.id)
      if (dead) return
      host?.dispose()
      host = new BoardHost(api, {
        boardPath: board.path,
        readOnly: false,
        onSize: h => { if (host) host.frame.style.height = `${Math.max(EMBED_MIN_HEIGHT, Math.min(EMBED_MAX_HEIGHT, h))}px` },
        onError: msg => { status.textContent = `⚠ ${msg}`; status.className = 'board-status-bad' },
        confirmWrite: what => confirmIn(el, what),
      })
      host.frame.style.height = `${EMBED_MIN_HEIGHT * 3}px`
      el.replaceChildren(host.frame, foot)
      host.load(source)
    }
    again.addEventListener('click', e => { e.preventDefault(); void run().catch(err => fail(String(err?.message ?? err))) })
    await run()
  }).catch(err => fail(String(err?.message ?? err)))
  return el
}
