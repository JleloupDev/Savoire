// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Rendu d'une diapositive (note `type: slides`, voir plugin-api/slides.ts).
// Le contenu est rendu comme la note : Markdown, colonnes, et les blocs des
// plugins (schemas, images, animations integrees ![[x.anim]]...).
//
// Une diapositive a une taille fixe (1280 x 720 en 16:9, 1024 x 768 en 4:3).
// L'ecran la met a l'echelle ; l'impression en fait une page ; l'export
// PowerPoint lit ce rendu.
import { BLOCK_DESTROY_EVENT, slideSteps, type BlockRegistry, type HookRegistry, type Slide, type SlideDecor, type SlideDeck, type SlideEffect, type SlideRatio, type SlideTheme, type SlideTransition } from '@savoire/plugin-api'
import { COLUMNS_CSS, renderFragmentInto } from './NoteFragment'

export const SLIDE_SIZE: Record<SlideRatio, { w: number; h: number }> = {
  '16:9': { w: 1280, h: 720 },
  '4:3': { w: 1024, h: 768 },
}

export interface SlideColors {
  bg: string
  text: string
  muted: string
  heading: string
  accent: string
  surface: string
  border: string
  /** Italique, liens, code en ligne (l'editeur les colore). */
  em: string
  link: string
  code: string
  /** Gras : couleur des titres dans les themes, celle du texte dans l'editeur. */
  strong: string
}

type FixedTheme = Exclude<SlideTheme, 'éditeur'>

const fixed = (c: Omit<SlideColors, 'em' | 'link' | 'code' | 'strong'>): SlideColors => ({ ...c, em: c.text, link: c.accent, code: c.text, strong: c.heading })

export const SLIDE_COLORS: Record<FixedTheme, SlideColors> = {
  clair: fixed({ bg: '#ffffff', text: '#1f2328', muted: '#57606a', heading: '#0f172a', accent: '#2563eb', surface: '#f3f4f6', border: '#d0d7de' }),
  sombre: fixed({ bg: '#16181d', text: '#e6e6e6', muted: '#9aa0a6', heading: '#ffffff', accent: '#8ab4f8', surface: '#262a31', border: '#3a3f47' }),
  bleu: fixed({ bg: '#0f2a4a', text: '#e8f0fb', muted: '#a8bdd8', heading: '#ffffff', accent: '#ffd166', surface: '#163a63', border: '#2d5383' }),
  'sépia': fixed({ bg: '#f6efe1', text: '#3b2f22', muted: '#7a6650', heading: '#2a2016', accent: '#a0522d', surface: '#ece2cc', border: '#d6c7a8' }),
}

/** Une couleur CSS en #rrggbb (l'export PowerPoint n'en lit pas d'autre). */
export function toHex(value: string, doc: Document = document): string | null {
  const v = value.trim()
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase()
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(v)
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase()
  if (!v || !doc.body) return null
  // Autre ecriture (rgb(), nom...) : le navigateur la traduit.
  const probe = doc.createElement('span')
  probe.style.color = v
  doc.body.appendChild(probe)
  const rgb = getComputedStyle(probe).color
  probe.remove()
  const m = /rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(rgb)
  return m ? `#${[m[1], m[2], m[3]].map(n => Number(n).toString(16).padStart(2, '0')).join('')}` : null
}

/**
 * Les couleurs de l'editeur, lues dans le theme de l'appli : fond de la note,
 * texte, titres (--heading-color), italique et liens (--color-info), code
 * (--color-code). Une variable absente garde la couleur du theme clair.
 */
export function editorSlideColors(doc: Document = document): SlideColors {
  const base = SLIDE_COLORS.clair
  const style = doc.documentElement && typeof getComputedStyle === 'function' ? getComputedStyle(doc.documentElement) : null
  const read = (fallback: string, ...names: string[]) => {
    for (const n of names) {
      const hex = toHex(style?.getPropertyValue(n) ?? '', doc)
      if (hex) return hex
    }
    return fallback
  }
  const text = read(base.text, '--text')
  const accent = read(base.accent, '--accent')
  const info = read(accent, '--color-info')
  return {
    bg: read(base.bg, '--bg-base'),
    text,
    muted: read(base.muted, '--text-muted'),
    heading: read(accent, '--heading-color', '--accent'),
    accent,
    surface: read(base.surface, '--bg-elevated', '--bg-surface'),
    border: read(base.border, '--border'),
    em: info,
    link: info,
    code: read(text, '--color-code'),
    strong: text,
  }
}

/** Les couleurs d'un theme (« éditeur » : lues dans l'appli, au moment du rendu). */
export function slideColors(theme: SlideTheme, doc: Document = document): SlideColors {
  return theme === 'éditeur' ? editorSlideColors(doc) : SLIDE_COLORS[theme]
}

export interface SlideRenderOptions {
  registry?: BlockRegistry | null
  hooks?: HookRegistry | null
  /** Plugins actifs dans cette note (null : tous). */
  activeIds?: Set<string> | null
}

const STYLE_ID = 'plume-slides-style'

export const SLIDES_CSS = `
.plume-slide {
  position: relative; box-sizing: border-box; overflow: hidden; flex: none;
  display: flex; flex-direction: column;
  padding: 56px 72px 64px;
  background: var(--slide-bg); color: var(--slide-text);
  font-family: var(--font-ui, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif);
  font-size: calc(30px * var(--slide-scale, 1)); line-height: 1.35;
  text-align: left;
  /* Les rendus des plugins lisent les couleurs de l'appli : celles du theme. */
  --text: var(--slide-text); --text-normal: var(--slide-text); --text-muted: var(--slide-muted); --text-faint: var(--slide-muted);
  --heading-color: var(--slide-heading); --accent: var(--slide-accent);
  --color-info: var(--slide-em); --color-code: var(--slide-code);
  --bg: var(--slide-bg); --bg-base: var(--slide-bg); --bg-surface: var(--slide-surface); --bg-elevated: var(--slide-surface);
  --border: var(--slide-border);
}
.plume-slide * { box-sizing: border-box; }
.plume-slide-body { flex: 1; min-height: 0; display: flex; flex-direction: column; justify-content: flex-start; }
.plume-slide-cover .plume-slide-body { justify-content: center; align-items: center; text-align: center; }
.plume-slide-cover .plume-slide-body > * { max-width: 100%; }
.plume-slide .vault-rendered-block, .plume-slide .plume-plugin-render { margin: 0; padding: 0; max-width: none; }
.plume-slide h1, .plume-slide h2, .plume-slide h3, .plume-slide h4 { color: var(--slide-heading); line-height: 1.15; font-weight: 700; }
.plume-slide h1 { font-size: 2.1em; margin: 0 0 .35em; }
.plume-slide h2 { font-size: 1.55em; margin: 0 0 .55em; }
.plume-slide h3 { font-size: 1.2em; margin: .2em 0 .35em; }
.plume-slide h4, .plume-slide h5, .plume-slide h6 { font-size: 1em; margin: .2em 0 .3em; }
.plume-slide-cover h1 { font-size: 2.5em; margin-bottom: .3em; }
.plume-slide-cover h2 { color: var(--slide-muted); font-weight: 500; }
.plume-slide p { margin: 0 0 .5em; }
.plume-slide ul, .plume-slide ol { margin: 0 0 .5em; padding-left: 1.2em; }
.plume-slide li { margin: .18em 0; }
.plume-slide li::marker { color: var(--slide-accent); }
.plume-slide li:has(> input[type="checkbox"]) { list-style: none; }
.plume-slide strong { color: var(--slide-strong); }
.plume-slide em { color: var(--slide-em); }
.plume-slide a { color: var(--slide-link); text-decoration: none; }
.plume-slide blockquote { margin: 0 0 .6em; padding: .1em 0 .1em .8em; border-left: 5px solid var(--slide-accent); color: var(--slide-muted); }
.plume-slide hr { border: 0; border-top: 2px solid var(--slide-border); margin: .6em 0; }
.plume-slide img, .plume-slide video { max-width: 100%; max-height: 470px; object-fit: contain; border-radius: 6px; }
.plume-slide svg { max-width: 100%; }
.plume-slide code { font-family: var(--font-code, var(--font-mono, ui-monospace, 'Cascadia Code', Menlo, monospace)); font-size: .85em; color: var(--slide-code); background: var(--slide-surface); padding: .05em .3em; border-radius: 4px; }
.plume-slide pre { margin: 0 0 .6em; font-size: .62em; line-height: 1.45; background: var(--slide-surface); padding: .8em 1em; border-radius: 8px; white-space: pre-wrap; overflow: hidden; }
.plume-slide pre { color: var(--slide-text); }
.plume-slide pre code { background: none; padding: 0; font-size: 1em; color: inherit; }
.plume-slide table { border-collapse: collapse; font-size: .72em; margin: 0 0 .6em; }
.plume-slide th, .plume-slide td { border: 1px solid var(--slide-border); padding: .3em .7em; }
.plume-slide th { background: var(--slide-surface); }
.plume-slide iframe { max-width: 100%; border: 0; }
/* Un bloc qui sait se reduire (data-fit : une animation) prend la place qui
   reste sous le texte : la chaine jusqu'a lui se laisse retrecir. */
.plume-slide-body > [data-fit], .plume-slide-body > :has([data-fit]) { flex: 0 1 auto; min-height: 0; }
.plume-slide-body > :has([data-fit]):not(.plume-columns-wrap) { display: flex; flex-direction: column; }
.plume-slide-body > .plume-columns-wrap:has([data-fit]) { display: flex; flex-direction: column; }
.plume-slide .plume-columns:has([data-fit]) { flex: 0 1 auto; min-height: 0; grid-template-rows: minmax(0, auto); }
.plume-slide .plume-column:has([data-fit]) { align-self: stretch !important; min-height: 0; display: flex; flex-direction: column; }
.plume-slide .plume-column [data-fit] { flex: 0 1 auto; min-height: 0; }
/* Decor, dessine avec les couleurs du theme, sous le contenu. */
.plume-slide > .plume-slide-body, .plume-slide > .plume-slide-foot { position: relative; z-index: 2; }
.plume-slide > .plume-slide-foot { position: absolute; }
.plume-slide-decor { position: absolute; inset: 0; z-index: 0; pointer-events: none; overflow: hidden; }
.plume-slide-decor::before, .plume-slide-decor::after { content: ''; position: absolute; }
.plume-slide[data-decor="bande"] .plume-slide-decor::before { left: 0; right: 0; top: 0; height: 14px; background: var(--slide-accent); }
.plume-slide[data-decor="bande"] .plume-slide-decor::after { left: 72px; width: 120px; bottom: 54px; height: 4px; border-radius: 2px; background: var(--slide-accent); opacity: .55; }
.plume-slide[data-decor="dégradé"] .plume-slide-decor { background:
  radial-gradient(circle at 88% 8%, color-mix(in srgb, var(--slide-accent) 22%, transparent), transparent 52%),
  radial-gradient(circle at 0% 100%, color-mix(in srgb, var(--slide-heading) 14%, transparent), transparent 50%); }
.plume-slide[data-decor="formes"] .plume-slide-decor::before { width: 560px; height: 560px; right: -190px; top: -230px; border-radius: 50%; background: color-mix(in srgb, var(--slide-accent) 16%, transparent); }
.plume-slide[data-decor="formes"] .plume-slide-decor::after { width: 300px; height: 300px; left: -120px; bottom: -150px; border-radius: 50%; border: 36px solid color-mix(in srgb, var(--slide-heading) 12%, transparent); }
/* Image de fond : toute la diapositive (voile pour le texte), ou une moitie. */
.plume-slide-image { position: absolute; inset: 0; z-index: 1; overflow: hidden; pointer-events: none; }
.plume-slide-image img { display: block; width: 100%; height: 100%; max-width: none; max-height: none; object-fit: cover; border-radius: 0; }
.plume-slide[data-image="plein"] .plume-slide-image::after { content: ''; position: absolute; inset: 0; background: color-mix(in srgb, var(--slide-bg) 50%, transparent); }
.plume-slide[data-image="gauche"] .plume-slide-image { right: 50%; }
.plume-slide[data-image="droite"] .plume-slide-image { left: 50%; }
.plume-slide[data-image="gauche"] { padding-left: calc(50% + 56px); }
.plume-slide[data-image="droite"] { padding-right: calc(50% + 56px); }
.plume-slide[data-image="gauche"] > .plume-slide-foot { left: calc(50% + 56px); }
.plume-slide[data-image="droite"] > .plume-slide-foot { right: calc(50% + 40px); }
.plume-slide[data-image="gauche"] .plume-slide-decor, .plume-slide[data-image="droite"] .plume-slide-decor { z-index: 1; }
/* Etapes : ce qui apparait au clic. */
.plume-step { transition: opacity .45s ease, transform .45s ease; }
.plume-step-hidden { opacity: 0 !important; pointer-events: none; }
.plume-slide[data-effect="montée"] .plume-step-hidden { transform: translateY(.9em); }
.plume-slide[data-effect="zoom"] .plume-step-hidden { transform: scale(.82); }
.plume-slide[data-effect="zoom"] .plume-step { transform-origin: 0 50%; }
.plume-slide-cover[data-effect="zoom"] .plume-step { transform-origin: 50% 50%; }
.plume-step-group > [data-fit] { flex: 0 1 auto; min-height: 0; }
@media (prefers-reduced-motion: reduce) { .plume-step { transition: none; } }
.plume-slide-foot { position: absolute; left: 72px; right: 40px; bottom: 18px; display: flex; justify-content: space-between; gap: 16px; font-size: 16px; color: var(--slide-muted); pointer-events: none; }
${COLUMNS_CSS}`

/** Pose les regles des diapositives dans `doc`, une fois. */
export function ensureSlidesStyle(doc: Document = document): void {
  if (doc.getElementById(STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = SLIDES_CSS
  doc.head.appendChild(style)
}

/** Couleurs du theme, en variables CSS sur la diapositive. */
export function applySlideTheme(el: HTMLElement, theme: SlideTheme): void {
  const c = slideColors(theme, el.ownerDocument)
  el.dataset.theme = theme
  for (const [k, v] of Object.entries(c)) el.style.setProperty(`--slide-${k}`, v)
}

/** Reglages d'une diapositive : les siens, sinon ceux de la presentation. */
export function slideSettings(deck: SlideDeck, slide: Slide): { transition: SlideTransition; effect: SlideEffect; decor: SlideDecor; builds: boolean } {
  const o = slide.options
  return {
    transition: o?.transition ?? deck.transition ?? 'aucune',
    effect: o?.effect ?? deck.effect ?? 'fondu',
    decor: o?.decor ?? deck.decor ?? 'aucun',
    builds: o?.builds ?? deck.builds ?? false,
  }
}

/** Un element de premier niveau d'une liste (pas un sous-point, pas dans un rendu de plugin). */
function buildItems(group: HTMLElement): HTMLElement[] {
  return Array.from(group.querySelectorAll<HTMLElement>('li')).filter(li =>
    !li.parentElement?.closest('li') && !li.closest('.plume-plugin-render'))
}

const firstBlockIsList = (group: HTMLElement): boolean => {
  const first = group.firstElementChild
  const inner = first?.firstElementChild
  return !!first && (/^(UL|OL)$/.test(first.tagName) || (!!inner && /^(UL|OL)$/.test(inner.tagName)))
}

/**
 * Le contenu, par etapes : chaque morceau entre deux `. . .`, et les points
 * des listes si elles apparaissent un par un. Chaque element revele porte
 * `data-step` (1, 2...) ; tout reste visible tant qu'on n'appelle pas
 * setSlideStep (export, miniatures).
 */
function renderSteps(body: HTMLElement, markdown: string, builds: boolean, opts: SlideRenderOptions): number {
  const fragment = { registry: opts.registry, hooks: opts.hooks, activeIds: opts.activeIds, ctx: { editorView: null } }
  const parts = slideSteps(markdown)
  if (parts.length === 1 && !builds) {
    renderFragmentInto(body, markdown, fragment)
    return 0
  }
  let step = 0
  parts.forEach((part, i) => {
    const group = document.createElement('div')
    group.className = 'plume-step-group'
    renderFragmentInto(group, part, fragment)
    body.appendChild(group)
    // Le premier point d'une liste qui ouvre son etape arrive avec elle.
    let shared = false
    if (i > 0) {
      group.dataset.step = String(++step)
      group.classList.add('plume-step')
      shared = builds && firstBlockIsList(group)
    }
    if (!builds) return
    for (const li of buildItems(group)) {
      if (shared) { shared = false; continue }
      li.dataset.step = String(++step)
      li.classList.add('plume-step')
    }
  })
  return step
}

/** Une diapositive, a sa taille reelle (non mise a l'echelle). */
export function renderSlide(deck: SlideDeck, slide: Slide, opts: SlideRenderOptions = {}): HTMLElement {
  const { w, h } = SLIDE_SIZE[deck.ratio]
  const set = slideSettings(deck, slide)
  const el = document.createElement('section')
  el.className = `plume-slide${slide.cover ? ' plume-slide-cover' : ''}`
  el.dataset.slide = String(slide.index + 1)
  el.style.width = `${w}px`
  el.style.height = `${h}px`
  applySlideTheme(el, deck.theme)
  if (slide.options?.background) el.style.setProperty('--slide-bg', slide.options.background)
  el.dataset.effect = set.effect
  el.dataset.transition = set.transition
  if (set.decor !== 'aucun') {
    el.dataset.decor = set.decor
    const decor = document.createElement('div')
    decor.className = 'plume-slide-decor'
    decor.setAttribute('aria-hidden', 'true')
    el.appendChild(decor)
  }
  if (slide.image) {
    el.dataset.image = slide.image.side
    const box = document.createElement('div')
    box.className = 'plume-slide-image'
    box.setAttribute('aria-hidden', 'true')
    const holder = document.createElement('div')
    renderFragmentInto(holder, slide.image.markdown, { registry: opts.registry, hooks: opts.hooks, activeIds: opts.activeIds, ctx: { editorView: null } })
    // L'image seule (sans sa poignee ni sa marge), couvrant sa zone.
    const img = holder.querySelector('img')
    if (img) {
      img.removeAttribute('style')
      img.removeAttribute('width')
      img.removeAttribute('height')
      box.appendChild(img)
    } else {
      box.append(...Array.from(holder.childNodes))
    }
    el.appendChild(box)
  }
  const body = document.createElement('div')
  body.className = 'plume-slide-body'
  const steps = renderSteps(body, slide.markdown, set.builds, opts)
  if (steps) el.dataset.steps = String(steps)
  el.appendChild(body)
  if (deck.numbers || deck.footer) {
    const foot = document.createElement('div')
    foot.className = 'plume-slide-foot'
    const left = document.createElement('span')
    left.textContent = deck.footer
    const right = document.createElement('span')
    right.textContent = deck.numbers ? `${slide.index + 1} / ${deck.slides.length}` : ''
    foot.append(left, right)
    el.appendChild(foot)
  }
  return el
}

/** Nombre d'etapes d'une diapositive rendue (0 : tout d'un coup). */
export function slideStepCount(el: HTMLElement): number {
  return Number(el.dataset.steps ?? 0) || 0
}

/** Montre les etapes jusqu'a `step` (0 : rien de ce qui apparait au clic). */
export function setSlideStep(el: HTMLElement, step: number): void {
  el.dataset.shown = String(step)
  for (const s of Array.from(el.querySelectorAll<HTMLElement>('[data-step]'))) {
    s.classList.toggle('plume-step-hidden', Number(s.dataset.step) > step)
  }
}

/**
 * Le contenu trop long reduit, pour tenir dans la diapositive (jusqu'a 45 %
 * de sa taille). A appeler une fois la diapositive dans la page ; une image
 * qui arrive apres relance le calcul.
 */
export function fitSlide(el: HTMLElement): void {
  const body = el.querySelector<HTMLElement>('.plume-slide-body')
  if (!body) return
  const run = () => {
    let scale = 1
    el.style.setProperty('--slide-scale', '1')
    for (let i = 0; i < 8; i++) {
      const over = body.scrollHeight - body.clientHeight
      const wide = body.scrollWidth - body.clientWidth
      if (over <= 1 && wide <= 1) break
      const ratio = Math.min(body.clientHeight / Math.max(1, body.scrollHeight), body.clientWidth / Math.max(1, body.scrollWidth))
      const next = Math.max(0.45, Math.min(scale - 0.04, scale * ratio))
      if (next >= scale) break
      scale = next
      el.style.setProperty('--slide-scale', scale.toFixed(3))
    }
  }
  run()
  for (const img of Array.from(el.querySelectorAll('img'))) {
    if (!img.complete) img.addEventListener('load', run, { once: true })
  }
}

/** Previent les rendus des plugins qu'ils quittent la page (cadres, abonnements). */
export function releaseSlide(el: Element | null | undefined): void {
  if (!el) return
  for (const r of Array.from(el.querySelectorAll('.plume-plugin-render'))) r.dispatchEvent(new CustomEvent(BLOCK_DESTROY_EVENT))
}
