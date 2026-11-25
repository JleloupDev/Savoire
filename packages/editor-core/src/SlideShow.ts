// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Mode presentation d'une note `type: slides` : plein ecran, une diapositive
// a la fois, au clavier comme PowerPoint ou reveal.js.
//
//  →  ↓  Espace  Page suivante  Entree   etape suivante (ce qui apparait
//                                        au clic), puis diapositive suivante
//  ←  ↑  Retour  Page precedente         en arriere
//  Debut / Fin                           premiere / derniere
//  un numero puis Entree                 aller a cette diapositive
//  O                                     vue d'ensemble
//  P                                     vue presentateur (notes, suivante, minuteur)
//  S                                     notes dans une autre fenetre (deux ecrans)
//  F                                     plein ecran
//  B  ou  .                              ecran noir
//  Echap                                 quitter
//
// Deux ecrans : la fenetre de Savoire va sur le projecteur (plein ecran) ;
// S ouvre les notes, la suivante et le minuteur dans une petite fenetre,
// pilotee au clavier elle aussi.
//
// Les diapositives sont rendues a la demande : une animation integree
// (![[x.anim]]) demarre quand sa diapositive s'affiche. Le passage d'une
// diapositive a l'autre suit sa transition (fondu, glissement, zoom, cube),
// sauf si le systeme demande moins d'animations.
import { slideDeck, type SlideDeck, type SlideTransition } from '@savoire/plugin-api'
import { markdownBlock } from './NoteFragment'
import { SLIDE_SIZE, ensureSlidesStyle, fitSlide, releaseSlide, renderSlide, setSlideStep, slideSettings, slideStepCount, type SlideRenderOptions } from './Slides'

export interface SlideShowOptions extends SlideRenderOptions {
  /** Titre de la presentation (nom de la note). */
  title?: string
  /** Diapositive de depart, a partir de 0. */
  start?: number
  /** Appele a la sortie (rendre le focus a l'editeur). */
  onExit?(): void
}

export interface SlideShowHandle {
  goTo(index: number): void
  /** Clic suivant : l'etape suivante, sinon la diapositive suivante. */
  next(): void
  previous(): void
  close(): void
  readonly index: number
  /** Etape montree de la diapositive (0 : avant le premier clic). */
  readonly step: number
}

const SHOW_CSS = `
.plume-show { position: fixed; inset: 0; z-index: 2147483000; background: #000; color: #e6e6e6; display: flex; flex-direction: column; outline: none; font-family: var(--font-ui, system-ui, sans-serif); user-select: none; }
.plume-show-main { flex: 1; min-height: 0; display: flex; gap: 16px; }
.plume-show-stage { position: relative; flex: 1; min-width: 0; overflow: hidden; perspective: 2200px; }
.plume-show-layer { position: absolute; inset: 0; backface-visibility: hidden; }
.plume-show-layer > .plume-slide { position: absolute; left: 0; top: 0; transform-origin: 0 0; box-shadow: 0 0 0 1px rgba(255,255,255,.04); }
.plume-show-side { display: none; width: 34%; min-width: 300px; flex-direction: column; gap: 12px; padding: 16px 16px 16px 0; overflow: hidden; }
.plume-show-presenter .plume-show-main { padding: 16px 0 0 16px; background: #111; }
.plume-show-presenter .plume-show-side { display: flex; }
.plume-show-label { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: #9aa0a6; }
.plume-show-next { position: relative; flex: none; aspect-ratio: 16 / 9; overflow: hidden; background: #000; border-radius: 4px; }
.plume-show-next-end { display: flex; align-items: center; justify-content: center; height: 100%; color: #9aa0a6; font-size: 14px; }
.plume-show-notes { flex: 1; min-height: 0; overflow: auto; font-size: 20px; line-height: 1.45; color: #f1f1f1; background: #1b1d22; border-radius: 6px; padding: 12px 16px; user-select: text; --text: #f1f1f1; --text-normal: #f1f1f1; --text-muted: #b5b5b5; --heading-color: #ffffff; --accent: #8ab4f8; --bg-elevated: #26292f; --border: #3a3f47; }
.plume-show-notes .vault-rendered-block, .plume-show-notes p, .plume-show-notes li { color: inherit; font-family: var(--font-ui, system-ui, sans-serif); }
.plume-show-notes p { margin: 0 0 .5em; }
.plume-show-notes-empty { color: #777; font-style: italic; }
.plume-show-clock { display: flex; align-items: center; gap: 10px; font-size: 26px; font-variant-numeric: tabular-nums; }
.plume-show-clock small { font-size: 14px; color: #9aa0a6; margin-left: auto; }
.plume-show-bar { position: absolute; left: 50%; bottom: 14px; transform: translateX(-50%); display: flex; align-items: center; gap: 4px; padding: 4px 6px; border-radius: 8px; background: rgba(20,20,24,.86); opacity: 0; transition: opacity .2s; z-index: 2; }
.plume-show:hover .plume-show-bar, .plume-show-bar:focus-within, .plume-show-presenter .plume-show-bar { opacity: 1; }
.plume-show-bar button { all: unset; cursor: pointer; padding: 4px 9px; border-radius: 5px; font-size: 14px; color: #e6e6e6; }
.plume-show-bar button:hover { background: rgba(255,255,255,.12); }
.plume-show-count { font-size: 13px; color: #b5b5b5; padding: 0 8px; font-variant-numeric: tabular-nums; }
.plume-show-black { position: absolute; inset: 0; background: #000; z-index: 3; display: none; }
.plume-show-blacked .plume-show-black { display: block; }
.plume-show-overview { position: absolute; inset: 0; z-index: 4; overflow: auto; background: #0a0a0c; padding: 28px; display: none; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 18px; align-content: start; }
.plume-show-overview-on .plume-show-overview { display: grid; }
.plume-show-thumb { position: relative; aspect-ratio: 16 / 9; overflow: hidden; border-radius: 4px; cursor: pointer; outline: 2px solid transparent; outline-offset: 3px; background: #000; }
.plume-show-thumb:hover { outline-color: rgba(255,255,255,.4); }
.plume-show-thumb-on { outline-color: #4c8dff; }
.plume-show-thumb > .plume-show-num { position: absolute; left: 6px; bottom: 4px; font-size: 12px; color: #fff; background: rgba(0,0,0,.55); padding: 1px 6px; border-radius: 4px; z-index: 1; }
.plume-show-thumb .plume-slide { pointer-events: none; }
.plume-show-goto { position: absolute; right: 18px; top: 14px; z-index: 5; font-size: 22px; background: rgba(20,20,24,.9); padding: 4px 12px; border-radius: 6px; display: none; }
.plume-show-goto-on { display: block; }
.plume-speaker { margin: 0; height: 100vh; display: flex; flex-direction: column; gap: 10px; padding: 12px; box-sizing: border-box; background: #111; color: #e6e6e6; font-family: system-ui, sans-serif; }
.plume-speaker-top { display: flex; gap: 12px; flex: none; height: 42%; }
.plume-speaker-top > div { flex: 1; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.plume-speaker .plume-show-next { flex: 1; aspect-ratio: auto; }
`

/** Les images cles d'une transition : la diapositive qui entre, celle qui sort. */
function transitionFrames(kind: SlideTransition, dir: number): { enter: Keyframe[]; leave: Keyframe[]; enterOrigin?: string; leaveOrigin?: string; duration: number } | null {
  const d = dir < 0 ? -1 : 1
  switch (kind) {
    case 'fondu':
      return { enter: [{ opacity: 0 }, { opacity: 1 }], leave: [{ opacity: 1 }, { opacity: 0 }], duration: 450 }
    case 'glissement':
      return { enter: [{ transform: `translateX(${d * 100}%)` }, { transform: 'translateX(0)' }], leave: [{ transform: 'translateX(0)' }, { transform: `translateX(${-d * 100}%)` }], duration: 550 }
    case 'zoom':
      return { enter: [{ opacity: 0, transform: 'scale(.72)' }, { opacity: 1, transform: 'scale(1)' }], leave: [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(1.18)' }], duration: 550 }
    case 'cube':
      return {
        enter: [{ transform: `translateX(${d * 100}%) rotateY(${d * 90}deg)` }, { transform: 'translateX(0) rotateY(0deg)' }],
        leave: [{ transform: 'translateX(0) rotateY(0deg)' }, { transform: `translateX(${-d * 100}%) rotateY(${-d * 90}deg)` }],
        enterOrigin: d > 0 ? '0% 50%' : '100% 50%',
        leaveOrigin: d > 0 ? '100% 50%' : '0% 50%',
        duration: 750,
      }
    default:
      return null
  }
}

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** Met une diapositive a l'echelle de son cadre, centree. */
function fitInto(box: HTMLElement, slide: HTMLElement, w: number, h: number): void {
  const bw = box.clientWidth, bh = box.clientHeight
  if (!bw || !bh) return
  const s = Math.min(bw / w, bh / h)
  slide.style.transformOrigin = '0 0'
  slide.style.transform = `translate(${Math.round((bw - w * s) / 2)}px, ${Math.round((bh - h * s) / 2)}px) scale(${s})`
}

function button(doc: Document, label: string, title: string, run: () => void, testid?: string): HTMLButtonElement {
  const b = doc.createElement('button')
  b.type = 'button'
  b.textContent = label
  b.title = title
  if (testid) b.dataset.testid = testid
  b.addEventListener('click', e => { e.stopPropagation(); run() })
  return b
}

const two = (n: number) => String(n).padStart(2, '0')
const clock = (ms: number) => { const s = Math.floor(ms / 1000); return `${two(Math.floor(s / 60))}:${two(s % 60)}` }

/** Lance la presentation de `text`. Rend null si la note n'a aucune diapositive. */
export function startSlideShow(text: string, opts: SlideShowOptions = {}): SlideShowHandle | null {
  const deck: SlideDeck = slideDeck(text)
  if (!deck.slides.length) return null
  ensureSlidesStyle()
  if (!document.getElementById('plume-show-style')) {
    const style = document.createElement('style')
    style.id = 'plume-show-style'
    style.textContent = SHOW_CSS
    document.head.appendChild(style)
  }
  const { w, h } = SLIDE_SIZE[deck.ratio]
  const count = deck.slides.length
  let index = Math.max(0, Math.min(count - 1, opts.start ?? 0))
  let closed = false
  let typed = ''
  const startedAt = Date.now()
  let pausedAt: number | null = null
  let pausedTotal = 0

  const root = document.createElement('div')
  root.className = 'plume-show'
  root.tabIndex = -1
  root.dataset.testid = 'slide-show'
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-label', opts.title ? `Présentation : ${opts.title}` : 'Présentation')

  const main = document.createElement('div')
  main.className = 'plume-show-main'
  const stage = document.createElement('div')
  stage.className = 'plume-show-stage'
  const side = document.createElement('div')
  side.className = 'plume-show-side'
  main.append(stage, side)

  const black = document.createElement('div')
  black.className = 'plume-show-black'
  const overview = document.createElement('div')
  overview.className = 'plume-show-overview'
  overview.dataset.testid = 'slide-show-overview'
  const goto = document.createElement('div')
  goto.className = 'plume-show-goto'

  const countEl = document.createElement('span')
  countEl.className = 'plume-show-count'
  countEl.dataset.testid = 'slide-show-count'
  const bar = document.createElement('div')
  bar.className = 'plume-show-bar'
  bar.append(
    button(document, '‹', 'Précédente (←)', () => previous(), 'slide-show-prev'),
    countEl,
    button(document, '›', 'Suivante (→)', () => next(), 'slide-show-next'),
    button(document, '▦', 'Vue d’ensemble (O)', () => toggleOverview()),
    button(document, '🗒', 'Vue présentateur (P)', () => togglePresenter(), 'slide-show-presenter'),
    button(document, '⧉', 'Notes dans une autre fenêtre (S)', () => openSpeakerWindow()),
    button(document, '⛶', 'Plein écran (F)', () => toggleFullscreen()),
    button(document, '✕', 'Quitter (Échap)', () => close(), 'slide-show-close'),
  )
  root.append(main, bar, black, overview, goto)

  // ── Vue presentateur : ici (P) ou dans une autre fenetre (S) ──
  interface Speaker { next: HTMLElement; notes: HTMLElement; timer: HTMLElement; now: HTMLElement; current?: HTMLElement; doc: Document }
  const speakers: Speaker[] = []

  const buildSpeaker = (doc: Document, container: HTMLElement, withCurrent: boolean): Speaker => {
    const label = (t: string) => { const l = doc.createElement('div'); l.className = 'plume-show-label'; l.textContent = t; return l }
    const next = doc.createElement('div')
    next.className = 'plume-show-next'
    const notes = doc.createElement('div')
    notes.className = 'plume-show-notes'
    notes.dataset.testid = 'slide-show-notes'
    const timer = doc.createElement('span')
    const now = doc.createElement('small')
    const clockRow = doc.createElement('div')
    clockRow.className = 'plume-show-clock'
    clockRow.append(timer,
      button(doc, '⏯', 'Mettre le minuteur en pause', () => {
        if (pausedAt === null) pausedAt = Date.now()
        else { pausedTotal += Date.now() - pausedAt; pausedAt = null }
        tick()
      }),
      button(doc, '↺', 'Remettre le minuteur à zéro', () => {
        const now = Date.now()
        pausedTotal = now - startedAt
        if (pausedAt !== null) pausedAt = now
        tick()
      }),
      now)
    let current: HTMLElement | undefined
    if (withCurrent) {
      const top = doc.createElement('div')
      top.className = 'plume-speaker-top'
      const a = doc.createElement('div')
      current = doc.createElement('div')
      current.className = 'plume-show-next'
      a.append(label('Diapositive actuelle'), current)
      const b = doc.createElement('div')
      b.append(label('Suivante'), next)
      top.append(a, b)
      container.append(top, clockRow, label('Notes'), notes)
    } else {
      container.append(label('Suivante'), next, clockRow, label('Notes'), notes)
    }
    return { next, notes, timer, now, current, doc }
  }

  const elapsed = () => (pausedAt ?? Date.now()) - startedAt - pausedTotal
  const tick = () => {
    const d = new Date()
    for (const s of speakers) {
      s.timer.textContent = clock(Math.max(0, elapsed()))
      s.now.textContent = `${two(d.getHours())}:${two(d.getMinutes())}`
    }
  }
  const timerId = setInterval(tick, 1000)

  /** Une diapositive en miniature dans `box` (aucune interaction), a une etape donnee. */
  const thumb = (box: HTMLElement, i: number, atStep?: number) => {
    releaseSlide(box)
    if (i >= count) {
      const end = box.ownerDocument.createElement('div')
      end.className = 'plume-show-next-end'
      end.textContent = 'Fin de la présentation'
      box.replaceChildren(end)
      return
    }
    const el = renderSlide(deck, deck.slides[i]!, opts)
    el.style.position = 'absolute'
    el.style.left = '0'
    el.style.top = '0'
    el.style.transformOrigin = '0 0'
    if (atStep !== undefined) setSlideStep(el, atStep)
    box.replaceChildren(el)
    fitSlide(el)
    const place = () => fitInto(box, el, w, h)
    place()
    requestAnimationFrame(place)
  }

  const fillSpeaker = (s: Speaker) => {
    // Suivante : ce que montre le prochain clic (une etape, ou la diapositive d'apres).
    if (step < steps) thumb(s.next, index, step + 1)
    else thumb(s.next, index + 1, 0)
    if (s.current) thumb(s.current, index, step)
    const notes = deck.slides[index]!.notes
    if (notes) s.notes.replaceChildren(markdownBlock(notes, opts.hooks))
    else {
      const empty = s.doc.createElement('div')
      empty.className = 'plume-show-notes-empty'
      empty.textContent = 'Pas de notes pour cette diapositive.'
      s.notes.replaceChildren(empty)
    }
  }

  // ── Diapositive affichee ──
  let shown: HTMLElement | null = null
  let layer: HTMLElement | null = null
  let step = 0
  let steps = 0
  let leaving: HTMLElement[] = []
  let running: Animation[] = []
  const place = () => { if (shown) fitInto(stage, shown, w, h) }
  /** Termine la transition en cours (on avance vite) : l'ancienne diapositive part. */
  const settle = () => {
    const anims = running
    running = []
    for (const a of anims) { try { a.finish() } catch { /* deja finie */ } }
    for (const l of leaving) { releaseSlide(l); l.remove() }
    leaving = []
  }
  const sync = () => {
    countEl.textContent = `${index + 1} / ${count}`
    root.dataset.slide = String(index + 1)
    root.dataset.step = String(step)
    root.dataset.steps = String(steps)
    for (const s of speakers) fillSpeaker(s)
  }
  /** Affiche la diapositive `index`, a l'etape `at` (-1 : toutes), venant de `from`. */
  const show = (from: number | null = null, at = 0) => {
    settle()
    const slide = deck.slides[index]!
    const el = renderSlide(deck, slide, opts)
    steps = slideStepCount(el)
    step = at < 0 ? steps : Math.min(at, steps)
    // Avant d'entrer dans la page : les etapes cachees n'apparaissent pas en fondu.
    setSlideStep(el, step)
    const incoming = document.createElement('div')
    incoming.className = 'plume-show-layer'
    incoming.appendChild(el)
    stage.appendChild(incoming)
    const old = layer
    shown = el
    layer = incoming
    fitSlide(el)
    place()
    if (old) {
      const dir = from === null ? 0 : Math.sign(index - from)
      // La transition est celle de la diapositive qui entre ; en arriere, celle qu'on defait.
      const owner = dir < 0 && from !== null ? deck.slides[from]! : slide
      const frames = dir === 0 || reducedMotion() || typeof incoming.animate !== 'function' ? null : transitionFrames(slideSettings(deck, owner).transition, dir)
      if (!frames) { releaseSlide(old); old.remove() }
      else {
        leaving.push(old)
        if (frames.enterOrigin) incoming.style.transformOrigin = frames.enterOrigin
        if (frames.leaveOrigin) old.style.transformOrigin = frames.leaveOrigin
        const timing: KeyframeAnimationOptions = { duration: frames.duration, easing: 'cubic-bezier(.4, 0, .2, 1)' }
        const enter = incoming.animate(frames.enter, timing)
        const leave = old.animate(frames.leave, { ...timing, fill: 'forwards' })
        running = [enter, leave]
        void enter.finished.then(() => { if (running.includes(enter)) settle() }, () => {})
      }
    }
    sync()
    for (const t of Array.from(overview.children)) t.classList.toggle('plume-show-thumb-on', (t as HTMLElement).dataset.index === String(index))
  }
  // La diapositive est placee dans le cadre, mise a l'echelle par lui.
  const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { place(); for (const s of speakers) { if (s.doc === document) fillSpeaker(s) } }) : null
  observer?.observe(stage)

  /** Va a la diapositive `i` (etape 0, ou toutes avec `all`). */
  const go = (i: number, all = false) => {
    const target = Math.max(0, Math.min(count - 1, i))
    if (target === index && shown) return
    const from = shown ? index : null
    index = target
    show(from, all ? -1 : 0)
  }
  const next = () => {
    if (step < steps && shown) { step++; setSlideStep(shown, step); sync() }
    else go(index + 1)
  }
  const previous = () => {
    if (step > 0 && shown) { step--; setSlideStep(shown, step); sync() }
    else go(index - 1, true)
  }

  const toggleOverview = (on = !root.classList.contains('plume-show-overview-on')) => {
    root.classList.toggle('plume-show-overview-on', on)
    if (!on) { for (const t of Array.from(overview.children)) releaseSlide(t); overview.replaceChildren(); return }
    deck.slides.forEach((_, i) => {
      const t = document.createElement('div')
      t.className = `plume-show-thumb${i === index ? ' plume-show-thumb-on' : ''}`
      t.dataset.index = String(i)
      const num = document.createElement('span')
      num.className = 'plume-show-num'
      num.textContent = String(i + 1)
      const box = document.createElement('div')
      box.style.cssText = 'position:absolute;inset:0'
      t.append(box, num)
      t.addEventListener('click', e => { e.stopPropagation(); toggleOverview(false); go(i) })
      overview.appendChild(t)
      thumb(box, i)
    })
  }

  let inWindow: Speaker | null = null
  const togglePresenter = (on = !root.classList.contains('plume-show-presenter')) => {
    root.classList.toggle('plume-show-presenter', on)
    if (on && !inWindow) {
      inWindow = buildSpeaker(document, side, false)
      speakers.push(inWindow)
      fillSpeaker(inWindow)
      tick()
    } else if (!on && inWindow) {
      releaseSlide(side)
      side.replaceChildren()
      speakers.splice(speakers.indexOf(inWindow), 1)
      inWindow = null
    }
    requestAnimationFrame(place)
  }

  let popup: Window | null = null
  const openSpeakerWindow = () => {
    if (popup && !popup.closed) { popup.focus(); return }
    popup = window.open('', 'savoire-notes-presentateur', 'popup=yes,width=1000,height=720')
    if (!popup) { togglePresenter(true); return }
    const doc = popup.document
    doc.open()
    doc.write('<!doctype html><html><head><meta charset="utf-8"></head><body class="plume-speaker"></body></html>')
    doc.close()
    doc.title = `Notes : ${opts.title ?? 'présentation'}`
    for (const s of Array.from(document.querySelectorAll('style, link[rel="stylesheet"]'))) doc.head.appendChild(doc.importNode(s, true))
    const sp = buildSpeaker(doc, doc.body, true)
    speakers.push(sp)
    fillSpeaker(sp)
    tick()
    doc.addEventListener('keydown', onKey)
    popup.addEventListener('resize', () => fillSpeaker(sp))
    popup.addEventListener('pagehide', () => { const i = speakers.indexOf(sp); if (i >= 0) speakers.splice(i, 1) })
  }

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {})
    else void root.requestFullscreen?.().catch(() => {})
  }

  function onKey(e: KeyboardEvent): void {
    if (closed || e.ctrlKey || e.metaKey || e.altKey) return
    const k = e.key
    let handled = true
    if (/^[0-9]$/.test(k)) {
      typed = (typed + k).slice(-4)
      goto.textContent = `→ ${typed}`
      goto.classList.add('plume-show-goto-on')
    } else if (k === 'Enter' && typed) {
      go(Number(typed) - 1)
      typed = ''
      goto.classList.remove('plume-show-goto-on')
    } else if (k === 'Escape') {
      if (typed) { typed = ''; goto.classList.remove('plume-show-goto-on') }
      else if (root.classList.contains('plume-show-overview-on')) toggleOverview(false)
      else if (root.classList.contains('plume-show-blacked')) root.classList.remove('plume-show-blacked')
      else close()
    } else if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter', 'n', 'N'].includes(k)) next()
    else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(k)) previous()
    else if (k === 'p' || k === 'P') togglePresenter()
    else if (k === 'Home') go(0)
    else if (k === 'End') go(count - 1)
    else if (k === 'o' || k === 'O' || k === 'g' || k === 'G') toggleOverview()
    else if (k === 's' || k === 'S') openSpeakerWindow()
    else if (k === 'f' || k === 'F') toggleFullscreen()
    else if (k === 'b' || k === 'B' || k === '.') root.classList.toggle('plume-show-blacked')
    else handled = false
    if (handled) { e.preventDefault(); e.stopPropagation() }
  }

  // Clic sur la diapositive : la suivante (pas sur un lien, un bouton, un cadre).
  stage.addEventListener('click', e => {
    root.focus()
    if ((e.target as HTMLElement).closest?.('a, button, input, select, textarea, iframe, video, audio, [contenteditable]')) return
    next()
  })
  stage.addEventListener('contextmenu', e => { e.preventDefault(); previous() })
  root.addEventListener('keydown', onKey)
  // Le focus peut partir (fenetre des notes, cadre d'une animation) : les touches suivent.
  const onWindowKey = (e: KeyboardEvent) => { if (!root.contains(e.target as Node)) onKey(e) }
  window.addEventListener('keydown', onWindowKey, true)

  function close(): void {
    if (closed) return
    closed = true
    clearInterval(timerId)
    observer?.disconnect()
    settle()
    window.removeEventListener('keydown', onWindowKey, true)
    releaseSlide(root)
    if (popup && !popup.closed) popup.close()
    if (document.fullscreenElement === root) void document.exitFullscreen?.().catch(() => {})
    root.remove()
    opts.onExit?.()
  }

  document.body.appendChild(root)
  show()
  root.focus()
  void root.requestFullscreen?.().catch(() => {})
  // Plein ecran quitte par le navigateur (Echap) : la presentation reste, a sa taille.
  root.addEventListener('fullscreenchange', () => requestAnimationFrame(place))

  return {
    goTo: i => go(i),
    next,
    previous,
    close,
    get index() { return index },
    get step() { return step },
  }
}
