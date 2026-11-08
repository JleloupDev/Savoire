// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Version bureau : le board tourne dans une page cadre servie avec sa propre
// CSP (une iframe srcdoc herite de celle de la fenetre, qui bloque le JS en
// ligne). La page dit qu'elle est prete, puis recoit le document du board.
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { PluginAPI } from '@savoire/plugin-api'
import { BoardHost, FRAME_BOOT, FRAME_READY, setBoardFrameUrl } from '@savoire/plugin-board'

afterEach(() => setBoardFrameUrl(null))

describe('board : page cadre (bureau)', () => {
  it('charge la page cadre, puis lui envoie le document quand elle est prete', () => {
    setBoardFrameUrl('savoire-board://localhost/')
    const host = new BoardHost({} as PluginAPI, { boardPath: 'b.board', readOnly: true })
    document.body.appendChild(host.frame)
    host.load('<p id="x">board</p>')
    expect(host.frame.getAttribute('srcdoc')).toBeNull()
    expect(host.frame.src).toMatch(/^savoire-board:\/\/localhost\/\?n=1$/)
    const win = host.frame.contentWindow!
    const sent: unknown[] = []
    vi.spyOn(win, 'postMessage').mockImplementation((m: unknown) => { sent.push(m) })

    // Un message « pret » d'ailleurs que du cadre est ignore.
    window.dispatchEvent(new MessageEvent('message', { data: { t: FRAME_READY }, source: window }))
    expect(sent).toEqual([])
    window.dispatchEvent(new MessageEvent('message', { data: { t: FRAME_READY }, source: win }))
    expect(sent).toHaveLength(1)
    const boot = sent[0] as { t: string; html: string }
    expect(boot.t).toBe(FRAME_BOOT)
    expect(boot.html).toContain('<p id="x">board</p>')
    expect(boot.html).toContain('Content-Security-Policy')
    // Une seule fois : un second « pret » (rechargement par le board) n'a rien a recevoir.
    window.dispatchEvent(new MessageEvent('message', { data: { t: FRAME_READY }, source: win }))
    expect(sent).toHaveLength(1)

    host.load('<p>v2</p>')
    expect(host.frame.src).toMatch(/\?n=2$/)
    host.dispose()
  })

  it('sans page cadre (navigateur) : srcdoc, comme avant', () => {
    const host = new BoardHost({} as PluginAPI, { boardPath: 'b.board', readOnly: true })
    host.load('<p>board</p>')
    expect(host.frame.srcdoc).toContain('<p>board</p>')
    host.dispose()
  })
})
