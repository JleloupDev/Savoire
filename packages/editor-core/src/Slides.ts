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
import { BLOCK_DESTROY_EVENT, type BlockRegistry, type HookRegistry, type Slide, type SlideDeck, type SlideRatio, type SlideTheme } from '@savoire/plugin-api'
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
}

export const SLIDE_COLORS: Record<SlideTheme, SlideColors> = {
  clair: { bg: '#ffffff', text: '#1f2328', muted: '#57606a', heading: '#0f172a', accent: '#2563eb', surface: '#f3f4f6', border: '#d0d7de' },
  sombre: { bg: '#16181d', text: '#e6e6e6', muted: '#9aa0a6', heading: '#ffffff', accent: '#8ab4f8', surface: '#262a31', border: '#3a3f47' },
  bleu: { bg: '#0f2a4a', text: '#e8f0fb', muted: '#a8bdd8', heading: '#ffffff', accent: '#ffd166', surface: '#163a63', border: '#2d5383' },
  'sépia': { bg: '#f6efe1', text: '#3b2f22', muted: '#7a6650', heading: '#2a2016', accent: '#a0522d', surface: '#ece2cc', border: '#d6c7a8' },
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
  --bg: var(--slide-bg); --bg-base: var(--slide-bg); --bg-surface: var(--slide-surface); --bg-elevated: var(--slide-surface);
  --border: var(--slide-border);
}
.plume-slide * { box-sizing: border-box; }
.plume-slide-body { flex: 1; min-height: 0; display: flex; flex-direction: column; justify-content: flex-start; }
.plume-slide-cover .plume-slide-body { justify-content: center; align-items: center; text-align: center; }
.plume-slide-cover .plume-slide-body > * { max-width: 100%; }
.plume-slide .vault-rendered-block, .plume-slide .plume-plugin-render { margin: 0; padding: 0; }
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
.plume-slide strong { color: var(--slide-heading); }
.plume-slide a { color: var(--slide-accent); text-decoration: none; }
.plume-slide blockquote { margin: 0 0 .6em; padding: .1em 0 .1em .8em; border-left: 5px solid var(--slide-accent); color: var(--slide-muted); }
.plume-slide hr { border: 0; border-top: 2px solid var(--slide-border); margin: .6em 0; }
.plume-slide img, .plume-slide video { max-width: 100%; max-height: 470px; object-fit: contain; border-radius: 6px; }
.plume-slide svg { max-width: 100%; }
.plume-slide code { font-family: var(--font-mono, ui-monospace, 'Cascadia Code', Menlo, monospace); font-size: .85em; background: var(--slide-surface); padding: .05em .3em; border-radius: 4px; }
.plume-slide pre { margin: 0 0 .6em; font-size: .62em; line-height: 1.45; background: var(--slide-surface); padding: .8em 1em; border-radius: 8px; white-space: pre-wrap; overflow: hidden; }
.plume-slide pre code { background: none; padding: 0; font-size: 1em; }
.plume-slide table { border-collapse: collapse; font-size: .72em; margin: 0 0 .6em; }
.plume-slide th, .plume-slide td { border: 1px solid var(--slide-border); padding: .3em .7em; }
.plume-slide th { background: var(--slide-surface); }
.plume-slide iframe { max-width: 100%; border: 0; }
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
  const c = SLIDE_COLORS[theme]
  el.dataset.theme = theme
  el.style.setProperty('--slide-bg', c.bg)
  el.style.setProperty('--slide-text', c.text)
  el.style.setProperty('--slide-muted', c.muted)
  el.style.setProperty('--slide-heading', c.heading)
  el.style.setProperty('--slide-accent', c.accent)
  el.style.setProperty('--slide-surface', c.surface)
  el.style.setProperty('--slide-border', c.border)
}

/** Une diapositive, a sa taille reelle (non mise a l'echelle). */
export function renderSlide(deck: SlideDeck, slide: Slide, opts: SlideRenderOptions = {}): HTMLElement {
  const { w, h } = SLIDE_SIZE[deck.ratio]
  const el = document.createElement('section')
  el.className = `plume-slide${slide.cover ? ' plume-slide-cover' : ''}`
  el.dataset.slide = String(slide.index + 1)
  el.style.width = `${w}px`
  el.style.height = `${h}px`
  applySlideTheme(el, deck.theme)
  const body = document.createElement('div')
  body.className = 'plume-slide-body'
  renderFragmentInto(body, slide.markdown, {
    registry: opts.registry,
    hooks: opts.hooks,
    activeIds: opts.activeIds,
    ctx: { editorView: null },
  })
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
