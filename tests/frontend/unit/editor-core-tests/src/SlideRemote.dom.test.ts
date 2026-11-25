// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Telecommande d'une presentation : le code QR de l'adresse, et la
// presentation pilotee par le telephone (ordres, etat annonce, fin).
import { describe, it, expect, afterEach } from 'vitest'
import { isLocalOrigin, isRemoteMessage, newRemoteSession, remoteUrl, type SlideRemoteLink, type SlideRemoteMessage } from '@savoire/plugin-api'
import { qrMatrix, qrSvg } from '../../../../../packages/editor-core/src/QrCode'
import { startSlideShow } from '../../../../../packages/editor-core/src/SlideShow'

describe('code QR', () => {
  it('choisit la version selon la longueur, avec ses motifs fixes', () => {
    const small = qrMatrix('A')
    expect(small.size).toBe(21)
    const big = qrMatrix(remoteUrl('https://savoire.example.org', '3f2b8c1e-5a4d-4e6f-9b0a-1c2d3e4f5a6b', '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d', newRemoteSession()))
    expect(big.size).toBe(53)
    for (const m of [small, big]) {
      const n = m.size
      // Les trois reperes : un carre sombre de 7, un anneau clair, un coeur de 3.
      for (const [x, y] of [[0, 0], [n - 7, 0], [0, n - 7]] as const) {
        expect(m.modules[y]![x]).toBe(true)
        expect(m.modules[y + 1]![x + 1]).toBe(false)
        expect(m.modules[y + 3]![x + 3]).toBe(true)
      }
      // Ligne de synchronisation : un module sur deux.
      for (let i = 8; i < n - 8; i++) expect(m.modules[6]![i]).toBe(i % 2 === 0)
      // Module toujours sombre.
      expect(m.modules[n - 8]![8]).toBe(true)
    }
    expect(qrSvg('A')).toMatch(/^<svg [^>]*viewBox="0 0 29 29"/)
  })
})

describe('protocole', () => {
  it('fabrique l adresse et reconnait les messages de la session', () => {
    const s = newRemoteSession()
    expect(s).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(remoteUrl('https://x.fr/', 'v', 'd', 's')).toBe('https://x.fr/?window=remote&vault=v&note=d&session=s')
    expect(isLocalOrigin('http://localhost:3002')).toBe(true)
    expect(isLocalOrigin('http://127.0.0.1:5000')).toBe(true)
    expect(isLocalOrigin('https://savoire.fr')).toBe(false)
    expect(isRemoteMessage({ role: 'remote', session: 's', seq: 1, cmd: 'next' }, 's')).toBe(true)
    expect(isRemoteMessage({ role: 'remote', session: 'x', seq: 1, cmd: 'next' }, 's')).toBe(false)
    expect(isRemoteMessage({ role: 'pirate', session: 's' }, 's')).toBe(false)
  })
})

const DECK = '---\ntype: slides\n---\n# Titre\n\nNotes : bonjour\n\n---\n\n## Deux\n\n- a\n- b\n\n. . .\n\nFin\n\nNotes : parler de a\n\n---\n\n## Trois\n'

function fakeLink() {
  const sent: SlideRemoteMessage[] = []
  let listener: ((m: SlideRemoteMessage) => void) | null = null
  let closed = false
  const link: SlideRemoteLink = {
    url: 'https://savoire.fr/?window=remote&vault=v&note=d&session=S1',
    local: false,
    send: m => { sent.push(m) },
    onMessage: cb => { listener = cb; return () => {} },
    close: () => { closed = true },
  }
  const order = (seq: number, cmd: 'hello' | 'next' | 'previous' | 'goto' | 'bye', index?: number) =>
    listener!({ role: 'remote', session: 'S1', seq, cmd, ...(index !== undefined ? { index } : {}) })
  return { link, sent, order, isClosed: () => closed }
}

describe('presentation pilotee par le telephone', () => {
  afterEach(() => { document.body.replaceChildren() })

  it('montre le code, obeit aux ordres du telephone et lui annonce les notes', () => {
    const f = fakeLink()
    const show = startSlideShow(DECK, { remote: { factory: () => f.link, docId: 'd' }, remoteOnStart: true })!
    const root = document.querySelector<HTMLElement>('[data-testid="slide-show"]')!
    expect(root.querySelector('[data-testid="slide-show-remote-qr"] svg')).not.toBeNull()
    expect(root.querySelector('[data-testid="slide-show-remote-url"]')?.textContent).toBe(f.link.url)
    // Avant le telephone, rien n'est envoye.
    expect(f.sent).toHaveLength(0)
    f.order(10, 'hello')
    expect(root.dataset.phone).toBe('connected')
    expect(f.sent.at(-1)).toMatchObject({ role: 'screen', session: 'S1', index: 0, count: 3, title: 'Titre', notes: 'bonjour', nextTitle: 'Deux' })
    f.order(11, 'next')
    expect(show.index).toBe(1)
    expect(f.sent.at(-1)).toMatchObject({ index: 1, step: 0, steps: 1, notes: 'parler de a' })
    // Un ordre deja vu (reemis) ne compte pas deux fois.
    f.order(11, 'next')
    expect([show.index, show.step]).toEqual([1, 0])
    f.order(12, 'next')
    expect([show.index, show.step]).toEqual([1, 1])
    f.order(13, 'previous')
    expect(show.step).toBe(0)
    f.order(14, 'goto', 2)
    expect(show.index).toBe(2)
    // L'ordinateur avance lui-meme : le telephone suit.
    show.goTo(0)
    expect(f.sent.at(-1)).toMatchObject({ index: 0 })
    show.close()
    expect(f.sent.at(-1)).toMatchObject({ ended: true })
    expect(f.isClosed()).toBe(true)
  })

  it('dit pourquoi la telecommande est indisponible', () => {
    startSlideShow(DECK, { remote: { factory: () => ({ reason: 'Vault local.' }), docId: 'd' }, remoteOnStart: true })
    const panel = document.querySelector('[data-testid="slide-show-remote-panel"]')!
    expect(panel.textContent).toContain('Vault local.')
    expect(panel.querySelector('svg')).toBeNull()
  })
})
