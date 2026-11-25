// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// La barre de lecture : lire / pause, la frise (on la glisse pour aller a un
// timecode), le temps, la boucle. Les commentaires y sont des reperes ; un
// clic sur un repere y ramene la lecture.
import { createIcon, type IconAPI } from '@savoire/plugin-api'
import { formatTimecode } from './format'
import type { AnimationPlayer } from './player'

export interface TransportMarker {
  id: string
  start: number
  end?: number
  title: string
  resolved?: boolean
}

export interface TransportOptions {
  icons?: IconAPI
  /** Barre reduite (integration dans une note, diapositive). */
  compact?: boolean
  onMarker?(id: string): void
}

export class Transport {
  readonly el: HTMLElement
  private readonly playBtn: HTMLButtonElement
  private readonly loopBtn: HTMLButtonElement
  private readonly track: HTMLElement
  private readonly fill: HTMLElement
  private readonly marks: HTMLElement
  private readonly time: HTMLElement
  private markers: TransportMarker[] = []
  private dragging = false

  constructor(private readonly player: AnimationPlayer, private readonly opts: TransportOptions = {}) {
    const el = document.createElement('div')
    el.className = `anim-transport${opts.compact ? ' anim-transport-compact' : ''}`
    el.dataset.testid = 'anim-transport'
    this.el = el

    this.playBtn = document.createElement('button')
    this.playBtn.type = 'button'
    this.playBtn.className = 'anim-btn anim-play'
    this.playBtn.dataset.testid = 'anim-play'
    this.playBtn.addEventListener('click', e => { e.stopPropagation(); player.toggle(); this.update() })

    this.track = document.createElement('div')
    this.track.className = 'anim-track'
    this.track.dataset.testid = 'anim-track'
    this.fill = document.createElement('div')
    this.fill.className = 'anim-track-fill'
    this.marks = document.createElement('div')
    this.marks.className = 'anim-track-marks'
    this.track.append(this.fill, this.marks)
    this.track.addEventListener('pointerdown', e => this.startDrag(e))

    this.time = document.createElement('span')
    this.time.className = 'anim-time'
    this.time.dataset.testid = 'anim-time'

    this.loopBtn = document.createElement('button')
    this.loopBtn.type = 'button'
    this.loopBtn.className = 'anim-btn anim-loop'
    this.loopBtn.title = 'Lire en boucle'
    this.loopBtn.dataset.testid = 'anim-loop'
    this.loopBtn.textContent = '⟳'
    this.loopBtn.addEventListener('click', e => { e.stopPropagation(); player.setLoop(!player.state.loop); this.update() })

    el.append(this.playBtn, this.track, this.time, this.loopBtn)
    this.update()
  }

  setMarkers(markers: TransportMarker[]): void {
    this.markers = markers
    this.drawMarkers()
  }

  /** Redessine d'apres l'etat du lecteur. */
  update(): void {
    const { playing, time, duration, loop } = this.player.state
    this.playBtn.replaceChildren(createIcon(this.opts.icons, playing ? 'pause' : 'play', { size: 14, label: playing ? 'Pause' : 'Lire' }))
    this.playBtn.title = playing ? 'Pause (Espace)' : 'Lire (Espace)'
    const p = duration > 0 ? Math.min(1, time / duration) : 0
    this.fill.style.width = `${(p * 100).toFixed(2)}%`
    this.time.textContent = this.opts.compact ? formatTimecode(time) : `${formatTimecode(time)} / ${formatTimecode(duration)}`
    this.loopBtn.classList.toggle('anim-btn-on', loop)
    this.loopBtn.setAttribute('aria-pressed', String(loop))
    this.drawMarkers()
  }

  private lastMarkersKey = ''

  private drawMarkers(): void {
    const duration = this.player.state.duration
    const key = `${duration}|${this.markers.map(m => `${m.id}:${m.start}:${m.end ?? ''}:${m.resolved ? 1 : 0}`).join(',')}`
    if (key === this.lastMarkersKey) return
    this.lastMarkersKey = key
    this.marks.replaceChildren()
    if (duration <= 0) return
    for (const m of this.markers) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = `anim-marker${m.end !== undefined && m.end > m.start ? ' anim-marker-range' : ''}${m.resolved ? ' anim-marker-done' : ''}`
      b.dataset.testid = 'anim-marker'
      b.title = m.title
      const left = Math.min(100, (m.start / duration) * 100)
      b.style.left = `${left}%`
      if (m.end !== undefined && m.end > m.start) b.style.width = `${Math.max(0.8, Math.min(100 - left, ((m.end - m.start) / duration) * 100))}%`
      b.addEventListener('pointerdown', e => e.stopPropagation())
      b.addEventListener('click', e => { e.stopPropagation(); this.player.seek(m.start); this.update(); this.opts.onMarker?.(m.id) })
      this.marks.appendChild(b)
    }
  }

  private timeAt(clientX: number): number {
    const r = this.track.getBoundingClientRect()
    const p = r.width > 0 ? Math.max(0, Math.min(1, (clientX - r.left) / r.width)) : 0
    return Math.round(p * this.player.state.duration)
  }

  private startDrag(e: PointerEvent): void {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    this.dragging = true
    this.player.seek(this.timeAt(e.clientX))
    this.update()
    const move = (ev: PointerEvent) => { if (this.dragging) { this.player.seek(this.timeAt(ev.clientX)); this.update() } }
    const up = () => { this.dragging = false; window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
}
