// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le lecteur : l'iframe isolee d'une animation et sa telecommande (lire,
// pause, timecode, boucle, viser un element). Sert a la vue du fichier, a
// l'integration dans une note et aux diapositives.
import { animeSource } from './anime'
import { FRAME_BOOT, FRAME_READY, MAX_MESSAGE, animationFrameUrl, buildSrcdoc, randomChannel, themeCss } from './frame'

export interface PlayerEvents {
  /** L'animation est prete : sa duree (ms). */
  onReady?(duration: number): void
  /** Le temps de lecture (ms), a chaque image. */
  onTime?(ms: number, duration: number): void
  onEnd?(): void
  onSize?(height: number): void
  onError?(message: string): void
  /** Element choisi dans la scene (mode « viser »). */
  onPicked?(selector: string, label: string): void
}

export interface PlayerState {
  playing: boolean
  time: number
  duration: number
  loop: boolean
}

export class AnimationPlayer {
  readonly frame: HTMLIFrameElement
  private readonly channel = randomChannel()
  private readonly onMessage = (e: MessageEvent) => this.handle(e)
  private disposed = false
  private ready = false
  private pendingHtml: string | null = null
  private loads = 0
  private wanted: { play: boolean; seek: number | null } = { play: false, seek: null }
  readonly state: PlayerState = { playing: false, time: 0, duration: 0, loop: false }

  constructor(title: string, private readonly events: PlayerEvents = {}) {
    const frame = document.createElement('iframe')
    frame.setAttribute('sandbox', 'allow-scripts')
    frame.setAttribute('referrerpolicy', 'no-referrer')
    frame.setAttribute('title', title)
    frame.dataset.testid = 'anim-frame'
    frame.className = 'anim-frame'
    this.frame = frame
    window.addEventListener('message', this.onMessage)
  }

  /** (Re)charge l'animation. Elle reprend la ou on en etait (temps, lecture). */
  async load(source: string, opts: { play?: boolean; at?: number } = {}): Promise<void> {
    const anime = await animeSource()
    if (this.disposed) return
    this.ready = false
    this.wanted = { play: opts.play ?? this.state.playing, seek: opts.at ?? (this.state.time || null) }
    // Les couleurs du lieu ou elle s'affiche : une diapositive a son theme.
    const html = buildSrcdoc(source, { channel: this.channel, anime, theme: themeCss(this.frame.isConnected ? this.frame : undefined) })
    const url = animationFrameUrl()
    if (!url) { this.frame.srcdoc = html; return }
    this.pendingHtml = html
    this.frame.src = `${url}${url.includes('?') ? '&' : '?'}n=${++this.loads}`
  }

  play(): void {
    this.state.playing = true
    if (!this.ready) { this.wanted.play = true; return }
    this.post({ t: 'play' })
  }

  pause(): void {
    this.state.playing = false
    if (!this.ready) { this.wanted.play = false; return }
    this.post({ t: 'pause' })
  }

  toggle(): void {
    if (this.state.playing) this.pause()
    else this.play()
  }

  /** Va au timecode `ms` et met en pause. */
  seek(ms: number): void {
    this.state.playing = false
    this.state.time = Math.max(0, ms)
    if (!this.ready) { this.wanted = { play: false, seek: ms }; return }
    this.post({ t: 'seek', ms })
  }

  setLoop(on: boolean): void {
    this.state.loop = on
    if (this.ready) this.post({ t: 'loop', on })
  }

  /** Mode « viser un element » : le prochain clic dans la scene le designe. */
  pick(on: boolean): void {
    if (this.ready) this.post({ t: 'pick', on })
  }

  /** Fait clignoter un element de la scene (commentaire qui le vise). */
  mark(selector: string): void {
    if (this.ready) this.post({ t: 'mark', sel: selector })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    window.removeEventListener('message', this.onMessage)
    this.pendingHtml = null
    if (animationFrameUrl()) this.frame.removeAttribute('src')
    else this.frame.srcdoc = ''
  }

  private post(msg: Record<string, unknown>): void {
    if (this.disposed) return
    // Origine opaque : '*' est la seule cible possible. Seule cette iframe le recoit.
    this.frame.contentWindow?.postMessage({ ch: this.channel, ...msg }, '*')
  }

  private handle(e: MessageEvent): void {
    if (this.disposed || e.source !== this.frame.contentWindow) return
    const m = e.data as { ch?: unknown; t?: unknown; ms?: unknown; d?: unknown; h?: unknown; m?: unknown; sel?: unknown; label?: unknown } | null
    if (m && typeof m === 'object' && m.t === FRAME_READY) {
      const html = this.pendingHtml
      this.pendingHtml = null
      if (html !== null) this.frame.contentWindow?.postMessage({ t: FRAME_BOOT, html }, '*')
      return
    }
    if (!m || typeof m !== 'object' || m.ch !== this.channel) return
    let size = 0
    try { size = JSON.stringify(m).length } catch { return }
    if (size > MAX_MESSAGE) return
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(86_400_000, v)) : 0)
    switch (m.t) {
      case 'ready': {
        this.state.duration = num(m.d)
        const first = !this.ready
        this.ready = true
        if (first) {
          this.post({ t: 'loop', on: this.state.loop })
          const { play, seek } = this.wanted
          if (seek !== null && seek > 0) this.post({ t: 'seek', ms: Math.min(seek, this.state.duration) })
          if (play) { this.state.playing = true; this.post({ t: 'play' }) }
        }
        this.events.onReady?.(this.state.duration)
        return
      }
      case 'time':
        this.state.time = num(m.ms)
        if (typeof m.d === 'number') this.state.duration = num(m.d)
        this.events.onTime?.(this.state.time, this.state.duration)
        return
      case 'end':
        if (!this.state.loop) this.state.playing = false
        this.events.onEnd?.()
        return
      case 'size':
        this.events.onSize?.(Math.min(20_000, num(m.h)))
        return
      case 'error':
        this.events.onError?.(String(m.m ?? 'Erreur').slice(0, 300))
        return
      case 'picked':
        if (typeof m.sel === 'string') this.events.onPicked?.(m.sel.slice(0, 300), String(m.label ?? m.sel).slice(0, 120))
        return
    }
  }
}
