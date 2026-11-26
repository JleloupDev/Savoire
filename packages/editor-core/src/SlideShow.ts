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
//  T                                     telecommande : le telephone fait
//                                        defiler et montre les notes (code QR)
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
import { qrSvg } from './QrCode'
import { REMOTE_NOTES_MAX, isRemoteMessage, type SlideRemoteLink } from '@savoire/plugin-api'
import type { SlideRemoteFactory } from './SlideRemote'
import { SLIDE_SIZE, ensureSlidesStyle, fitSlide, releaseSlide, renderSlide, setSlideStep, slideSettings, slideStepCount, type SlideRenderOptions } from './Slides'

export interface SlideShowOptions extends SlideRenderOptions {
  /** Titre de la presentation (nom de la note). */
  title?: string
  /** Diapositive de depart, a partir de 0. */
  start?: number
  /** Appele a la sortie (rendre le focus a l'editeur). */
  onExit?(): void
  /** Telecommande par telephone : le transport de l'appli, et la note. */
  remote?: { factory: SlideRemoteFactory; docId: string }
  /** Montrer le code QR de la telecommande des le debut. */
  remoteOnStart?: boolean
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
.plume-show-remote { position: absolute; right: 24px; top: 24px; z-index: 6; width: 300px; padding: 16px; border-radius: 10px; background: rgba(20,20,24,.94); color: #e6e6e6; font-size: 14px; line-height: 1.4; box-shadow: 0 10px 40px rgba(0,0,0,.5); display: none; user-select: text; }
.plume-show-remote-on .plume-show-remote { display: block; }
.plume-show-remote h3 { margin: 0 0 8px; font-size: 15px; }
.plume-show-remote-qr { background: #fff; border-radius: 6px; padding: 6px; }
.plume-show-remote-qr svg { display: block; width: 100%; height: auto; }
.plume-show-remote-url { margin-top: 8px; font-size: 11px; color: #9aa0a6; word-break: break-all; }
.plume-show-remote-warn { margin-top: 8px; font-size: 12px; color: #f5c26b; }
.plume-show-remote-status { margin-top: 10px; font-size: 13px; }
.plume-show-remote-status[data-state="connected"] { color: #7ee2a8; }
.plume-show-remote-close { all: unset; cursor: pointer; position: absolute; right: 10px; top: 8px; padding: 2px 6px; border-radius: 4px; color: #b5b5b5; }
.plume-show-remote-close:hover { background: rgba(255,255,255,.12); }
.plume-show-phone { font-size: 13px; padding: 0 6px; color: #7ee2a8; display: none; }
.plume-show-phone-on .plume-show-phone { display: inline; }
.plume-speaker { margin: 0; height: 100vh; display: flex; flex-direction: column; gap: 10px; padding: 12px; box-sizing: border-box; background: #111; color: #e6e6e6; font-family: system-ui, sans-serif; }
.plume-speaker-top { display: flex; gap: 12px; flex: none; height: 42%; }
.plume-speaker-top > div { flex: 1; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.plume-speaker .plume-show-next { flex: 1; aspect-ratio: auto; }
/* Ecran tactile : la barre reste visible (pas de survol). Telephone : boutons
   au doigt, sans ce qui sert a un second ecran (vue presentateur, fenetre des
   notes, telecommande : le telephone est deja l'ecran). */
@media (hover: none) { .plume-show-bar { opacity: 1; } }
@media (max-width: 600px), (max-height: 500px) {
  .plume-show-bar { bottom: max(10px, env(safe-area-inset-bottom)); gap: 2px; }
  .plume-show-bar button { min-width: 40px; min-height: 40px; padding: 0 6px; display: inline-flex; align-items: center; justify-content: center; font-size: 18px; }
  .plume-show-count { white-space: nowrap; padding: 0 4px; }
  .plume-show-bar [data-testid="slide-show-presenter"], .plume-show-bar [data-testid="slide-show-speaker-window"], .plume-show-bar [data-testid="slide-show-remote"] { display: none; }
  .plume-show-overview { padding: 12px; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); }
}
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

/**
 * Bouton retour du telephone (coquille mobile) : l'appli inscrit ici comment
 * une fenetre s'y abonne. Rend la fonction a appeler a la fermeture.
 */
type BackHandler = (close: () => void) => () => void
let backHandler: BackHandler | null = null
export function setSlideShowBackHandler(h: BackHandler | null): void {
  backHandler = h
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
  const phoneEl = document.createElement('span')
  phoneEl.className = 'plume-show-phone'
  phoneEl.textContent = '📱'
  phoneEl.title = 'Téléphone connecté'
  const bar = document.createElement('div')
  bar.className = 'plume-show-bar'
  bar.append(
    button(document, '‹', 'Précédente (←)', () => previous(), 'slide-show-prev'),
    countEl,
    phoneEl,
    button(document, '›', 'Suivante (→)', () => next(), 'slide-show-next'),
    button(document, '▦', 'Vue d’ensemble (O)', () => toggleOverview()),
    button(document, '🗒', 'Vue présentateur (P)', () => togglePresenter(), 'slide-show-presenter'),
    button(document, '⧉', 'Notes dans une autre fenêtre (S)', () => openSpeakerWindow(), 'slide-show-speaker-window'),
    ...(opts.remote ? [button(document, '📱', 'Télécommande sur le téléphone (T)', () => toggleRemote(), 'slide-show-remote')] : []),
    button(document, '⛶', 'Plein écran (F)', () => toggleFullscreen()),
    button(document, '✕', 'Quitter (Échap)', () => close(), 'slide-show-close'),
  )
  // Telecommande : le code QR a scanner, et l'etat du telephone.
  const remoteBox = document.createElement('div')
  remoteBox.className = 'plume-show-remote'
  remoteBox.dataset.testid = 'slide-show-remote-panel'
  remoteBox.addEventListener('click', e => e.stopPropagation())
  root.append(main, bar, black, overview, goto, remoteBox)

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
    announce()
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

  // ── Telecommande (telephone) ──
  let link: SlideRemoteLink | null = null
  let lastSeq = -1
  let phone = false
  const screenState = () => {
    const s = deck.slides[index]!
    return {
      role: 'screen' as const, session: '', index, count, step, steps,
      title: s.title, notes: s.notes.slice(0, REMOTE_NOTES_MAX), nextTitle: deck.slides[index + 1]?.title ?? '',
    }
  }
  const announce = () => { if (link && phone) link.send({ ...screenState(), session: sessionOf(link) }) }
  const sessionOf = (l: SlideRemoteLink) => new URL(l.url).searchParams.get('session') ?? ''
  const setPhone = (on: boolean) => {
    phone = on
    root.classList.toggle('plume-show-phone-on', on)
    root.dataset.phone = on ? 'connected' : ''
    const status = remoteBox.querySelector<HTMLElement>('.plume-show-remote-status')
    if (status) {
      status.dataset.state = on ? 'connected' : 'waiting'
      status.textContent = on ? '📱 Téléphone connecté : il fait défiler, ses notes suivent.' : 'En attente du téléphone…'
    }
  }
  const openRemote = (): SlideRemoteLink | null => {
    if (link || !opts.remote) return link
    const made = opts.remote.factory(opts.remote.docId)
    const close = document.createElement('button')
    close.className = 'plume-show-remote-close'
    close.textContent = '✕'
    close.title = 'Masquer (T)'
    close.addEventListener('click', () => toggleRemote(false))
    const head = document.createElement('h3')
    head.textContent = 'Présenter avec le téléphone'
    if ('reason' in made) {
      const why = document.createElement('div')
      why.className = 'plume-show-remote-warn'
      why.textContent = made.reason
      remoteBox.replaceChildren(close, head, why)
      return null
    }
    link = made
    const session = sessionOf(made)
    const help = document.createElement('div')
    help.textContent = 'Scannez ce code avec un téléphone connecté au même compte : il fera défiler les diapositives et montrera vos notes.'
    const qr = document.createElement('div')
    qr.className = 'plume-show-remote-qr'
    qr.dataset.testid = 'slide-show-remote-qr'
    qr.innerHTML = qrSvg(made.url)
    const url = document.createElement('div')
    url.className = 'plume-show-remote-url'
    url.dataset.testid = 'slide-show-remote-url'
    url.textContent = made.url
    const status = document.createElement('div')
    status.className = 'plume-show-remote-status'
    status.dataset.testid = 'slide-show-remote-status'
    remoteBox.replaceChildren(close, head, help, qr, url, ...(made.local ? [Object.assign(document.createElement('div'), {
      className: 'plume-show-remote-warn',
      textContent: 'Cette adresse ne mène qu’à cet ordinateur : un téléphone ne la joindra pas. Ouvrez Savoire par son adresse publique.',
    })] : []), status)
    setPhone(false)
    made.onMessage(m => {
      if (closed || !isRemoteMessage(m, session) || m.role !== 'remote') return
      if (m.cmd === 'hello') {
        lastSeq = m.seq
        setPhone(true)
        announce()
        // Le telephone est la : le code peut partir.
        setTimeout(() => { if (phone) toggleRemote(false) }, 1500)
        return
      }
      if (m.cmd === 'bye') { setPhone(false); return }
      if (m.seq <= lastSeq) return
      lastSeq = m.seq
      if (!phone) setPhone(true)
      if (m.cmd === 'next') next()
      else if (m.cmd === 'previous') previous()
      else if (m.cmd === 'goto' && typeof m.index === 'number') go(m.index)
      announce()
    })
    return made
  }
  const toggleRemote = (on = !root.classList.contains('plume-show-remote-on')) => {
    if (on) openRemote()
    root.classList.toggle('plume-show-remote-on', on)
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
    else if ((k === 't' || k === 'T') && opts.remote) toggleRemote()
    else handled = false
    if (handled) { e.preventDefault(); e.stopPropagation() }
  }

  // Au doigt : glisser vers la gauche pour la suivante, vers la droite pour
  // la precedente. Le clic qui suit un glissement ne compte pas.
  let touch: { x: number; y: number } | null = null
  let swiped = false
  stage.addEventListener('touchstart', e => {
    const t = e.touches[0]
    touch = e.touches.length === 1 && t ? { x: t.clientX, y: t.clientY } : null
  }, { passive: true })
  stage.addEventListener('touchend', e => {
    const t = e.changedTouches[0]
    if (!touch || !t) return
    const dx = t.clientX - touch.x, dy = t.clientY - touch.y
    touch = null
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return
    swiped = true
    setTimeout(() => { swiped = false }, 400)
    if (dx < 0) next()
    else previous()
  }, { passive: true })

  // Clic sur la diapositive : la suivante (pas sur un lien, un bouton, un cadre).
  stage.addEventListener('click', e => {
    root.focus()
    if (swiped) return
    if ((e.target as HTMLElement).closest?.('a, button, input, select, textarea, iframe, video, audio, [contenteditable]')) return
    next()
  })
  stage.addEventListener('contextmenu', e => { e.preventDefault(); previous() })
  root.addEventListener('keydown', onKey)
  // Le focus peut partir (fenetre des notes, cadre d'une animation) : les touches suivent.
  const onWindowKey = (e: KeyboardEvent) => { if (!root.contains(e.target as Node)) onKey(e) }
  window.addEventListener('keydown', onWindowKey, true)

  let releaseBack: (() => void) | null = null

  function close(): void {
    if (closed) return
    closed = true
    releaseBack?.()
    releaseBack = null
    clearInterval(timerId)
    observer?.disconnect()
    settle()
    if (link) {
      if (phone) link.send({ ...screenState(), session: sessionOf(link), ended: true })
      link.close()
      link = null
    }
    window.removeEventListener('keydown', onWindowKey, true)
    releaseSlide(root)
    if (popup && !popup.closed) popup.close()
    if (document.fullscreenElement === root) void document.exitFullscreen?.().catch(() => {})
    try { (screen.orientation as ScreenOrientation & { unlock?: () => void })?.unlock?.() } catch { /* pas de verrou */ }
    root.remove()
    opts.onExit?.()
  }

  document.body.appendChild(root)
  releaseBack = backHandler?.(() => { releaseBack = null; close() }) ?? null
  show()
  if (opts.remoteOnStart && opts.remote) toggleRemote(true)
  root.focus()
  // Telephone tenu droit : en plein ecran, l'image tourne en paysage (si le systeme le permet).
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
  void root.requestFullscreen?.()
    .then(() => {
      if (!coarse) return
      const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }
      return o?.lock?.('landscape')
    })
    .catch(() => {})
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
