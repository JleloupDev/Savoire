// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Format « slides » : une note Markdown qui devient une presentation, comme
// Marp ou reveal.js. Logique pure, partagee par l'editeur (presentation,
// export) et les outils d'agent (inserer dans une diapositive).
//
//  - Activation : la propriete `type: slides` (ou `présentation`).
//  - Separateur : une ligne `---` seule, PRECEDEE D'UNE LIGNE VIDE (ou en
//    tete du corps). C'est la regle de Marp. Elle leve les deux conflits :
//      · le frontmatter : seul le bloc `---` de la premiere ligne en est un,
//        il est retire avant le decoupage ;
//      · le titre Setext : `Texte` puis `---` colle dessous reste un titre,
//        la ligne vide manque.
//    Dans un bloc de code ou de maths, rien n'est coupe. Pour un trait
//    horizontal dans une diapositive : `***` ou `___`.
//  - Notes du presentateur : une ligne `Notes :` (ou `Note:`), seule ou
//    suivie du debut des notes ; tout ce qui suit dans la diapositive.
//  - Reglages, dans les proprietes : `thème` (éditeur, clair, sombre, bleu,
//    sépia), `format` (16:9, 4:3), `numéros` (oui / non), `pied` (texte en
//    bas), `transition` (fondu, glissement, zoom, cube), `apparition: listes`
//    (les points d'une liste un par un), `effet` (fondu, montée, zoom : comment
//    ils apparaissent), `décor` (bande, dégradé, formes).
//  - Dans une diapositive :
//      · une ligne `. . .` (comme Pandoc) : la suite apparait au clic suivant ;
//      · `![fond](photo.jpg)` ou `![[photo.jpg|fond]]` : image de fond, sur
//        toute la diapositive ; `fond gauche` / `fond droite` : sur une moitie,
//        le texte sur l'autre ;
//      · une ligne `<!-- transition: zoom; fond: #1e3a5f -->` : reglages de
//        cette diapositive seule (transition, fond, décor, apparition, effet).
//        Invisible hors de Savoire.
import { findFrontmatter, parseFrontmatter, setFrontmatterValue } from './properties'

// « éditeur » (par defaut) : les couleurs de l'editeur, celles du theme de l'appli.
export const SLIDE_THEMES = ['éditeur', 'clair', 'sombre', 'bleu', 'sépia'] as const
export type SlideTheme = typeof SLIDE_THEMES[number]

export type SlideRatio = '16:9' | '4:3'

export const SLIDE_TRANSITIONS = ['aucune', 'fondu', 'glissement', 'zoom', 'cube'] as const
export type SlideTransition = typeof SLIDE_TRANSITIONS[number]
export const SLIDE_EFFECTS = ['fondu', 'montée', 'zoom'] as const
export type SlideEffect = typeof SLIDE_EFFECTS[number]
export const SLIDE_DECORS = ['aucun', 'bande', 'dégradé', 'formes'] as const
export type SlideDecor = typeof SLIDE_DECORS[number]

/** Image de fond d'une diapositive : sur toute la diapositive ou sur une moitie. */
export interface SlideImage {
  /** Le Markdown qui rend l'image (`![[photo.jpg]]` ou `![](https://...)`). */
  markdown: string
  side: 'plein' | 'gauche' | 'droite'
}

/** Reglages propres a une diapositive (null : ceux de la presentation). */
export interface SlideOptions {
  transition: SlideTransition | null
  effect: SlideEffect | null
  decor: SlideDecor | null
  builds: boolean | null
  /** Couleur de fond ('' : celle du theme). */
  background: string
}

export interface Slide {
  /** Rang, a partir de 0. */
  index: number
  /** Debut et fin de la diapositive dans le texte de la note (separateur exclu). */
  from: number
  to: number
  /** Le contenu montre, sans les notes. */
  markdown: string
  /** Les notes du presentateur ('' : aucune). */
  notes: string
  /** Debut des notes dans le texte de la note (-1 : aucune). */
  notesFrom: number
  /** Le premier titre de la diapositive ('' : aucun). */
  title: string
  /** Diapositive de titre : elle commence par un titre de niveau 1 (centree). */
  cover: boolean
  /** Image de fond (null : aucune). Retiree de `markdown`. */
  image: SlideImage | null
  /** Reglages de cette diapositive (lignes `<!-- ... -->`, retirees de `markdown`). */
  options: SlideOptions
}

export interface SlideDeck {
  slides: Slide[]
  theme: SlideTheme
  ratio: SlideRatio
  /** Numero de la diapositive en bas a droite. */
  numbers: boolean
  /** Texte en bas a gauche de chaque diapositive ('' : aucun). */
  footer: string
  /** Debut du corps (apres le frontmatter). */
  bodyFrom: number
  transition: SlideTransition
  effect: SlideEffect
  decor: SlideDecor
  /** Les points des listes apparaissent un par un. */
  builds: boolean
}

const SLIDES_TYPES = new Set(['slides', 'slide', 'présentation', 'presentation', 'diapositives', 'diaporama'])

const fold = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()

/** Lit une propriete sous l'un de ses noms (« thème », « theme »...). */
function prop(props: Record<string, unknown>, names: string[]): unknown {
  const wanted = new Set(names.map(fold))
  for (const [k, v] of Object.entries(props)) if (wanted.has(fold(k))) return v
  return undefined
}

/** La note est-elle une presentation (`type: slides`) ? */
export function isSlidesNote(text: string): boolean {
  if (!text.startsWith('---')) return false
  const type = prop(parseFrontmatter(text), ['type'])
  const values = Array.isArray(type) ? type : [type]
  return values.some(v => typeof v === 'string' && SLIDES_TYPES.has(v.toLowerCase().trim()))
}

const NOTES_LINE = /^(?:notes?|note du présentateur|notes du présentateur)\s*:\s?(.*)$/i
const SEPARATOR_LINE = /^---[ \t]*$/
const FENCE = /^ {0,3}(`{3,}|~{3,})/
const MATH_FENCE = /^ {0,3}\$\$[ \t]*$/

interface Line { from: number; to: number; text: string }

function linesOf(text: string, from: number): Line[] {
  const out: Line[] = []
  let at = from
  while (at <= text.length) {
    const nl = text.indexOf('\n', at)
    const end = nl < 0 ? text.length : nl
    out.push({ from: at, to: end, text: text.slice(at, end).replace(/\r$/, '') })
    if (nl < 0) break
    at = nl + 1
  }
  return out
}

/**
 * Les lignes separatrices du corps : debut de chaque ligne `---` qui coupe
 * deux diapositives. Hors code et maths, precedee d'une ligne vide.
 */
export function slideSeparators(text: string, bodyFrom = findFrontmatter(text)?.end ?? 0): Line[] {
  const out: Line[] = []
  let fence: string | null = null
  let math = false
  let blankBefore = true
  for (const line of linesOf(text, bodyFrom)) {
    const t = line.text
    if (fence) {
      if (t.trimStart().startsWith(fence)) fence = null
      blankBefore = false
      continue
    }
    if (math) {
      if (MATH_FENCE.test(t)) math = false
      blankBefore = false
      continue
    }
    const f = FENCE.exec(t)
    if (f) { fence = f[1]!; blankBefore = false; continue }
    if (MATH_FENCE.test(t)) { math = true; blankBefore = false; continue }
    if (SEPARATOR_LINE.test(t) && blankBefore) {
      out.push(line)
      // Deux separateurs de suite : une diapositive vide entre eux.
      blankBefore = true
      continue
    }
    blankBefore = t.trim() === ''
  }
  return out
}

function headingOf(markdown: string): { title: string; level: number } {
  let fence = false
  for (const raw of markdown.split('\n')) {
    const t = raw.replace(/\r$/, '')
    if (FENCE.test(t)) { fence = !fence; continue }
    if (fence) continue
    const m = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t#]*$/.exec(t)
    if (m) return { title: m[2]!.trim(), level: m[1]!.length }
  }
  return { title: '', level: 0 }
}

/** Le premier bloc non vide est-il un titre de niveau 1 ? */
function startsWithH1(markdown: string): boolean {
  const first = markdown.split('\n').find(l => l.trim() !== '')
  return !!first && /^ {0,3}#[ \t]+\S/.test(first)
}

/** Coupe une diapositive en contenu et notes du presentateur. */
function splitNotes(text: string, from: number, to: number): { markdown: string; notes: string; notesFrom: number } {
  let fence = false
  for (const line of linesOf(text.slice(0, to), from)) {
    if (line.from >= to) break
    if (FENCE.test(line.text)) { fence = !fence; continue }
    if (fence) continue
    const m = NOTES_LINE.exec(line.text)
    if (!m) continue
    const rest = text.slice(Math.min(line.to + 1, to), to)
    const notes = [m[1] ?? '', rest].filter(s => s.trim() !== '').join('\n').trim()
    return { markdown: text.slice(from, line.from).trim(), notes, notesFrom: line.from }
  }
  return { markdown: text.slice(from, to).trim(), notes: '', notesFrom: -1 }
}

function yes(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v
  if (typeof v !== 'string') return fallback
  const s = fold(v)
  if (['non', 'no', 'false', 'faux', '0', 'off'].includes(s)) return false
  if (['oui', 'yes', 'true', 'vrai', '1', 'on'].includes(s)) return true
  return fallback
}

function themeOf(v: unknown): SlideTheme {
  const s = typeof v === 'string' ? fold(v) : ''
  const aliases: Record<string, SlideTheme> = {
    editeur: 'éditeur', editor: 'éditeur', app: 'éditeur', appli: 'éditeur', auto: 'éditeur',
    clair: 'clair', light: 'clair', blanc: 'clair',
    sombre: 'sombre', dark: 'sombre', noir: 'sombre',
    bleu: 'bleu', blue: 'bleu', nuit: 'bleu',
    sepia: 'sépia', papier: 'sépia', paper: 'sépia',
  }
  return aliases[s] ?? 'éditeur'
}

function pick<T extends string>(v: unknown, aliases: Record<string, T>): T | null {
  if (typeof v === 'boolean') return aliases[v ? 'oui' : 'non'] ?? null
  return typeof v === 'string' ? aliases[fold(v)] ?? null : null
}

const TRANSITION_ALIASES: Record<string, SlideTransition> = {
  aucune: 'aucune', aucun: 'aucune', non: 'aucune', none: 'aucune', no: 'aucune',
  fondu: 'fondu', fade: 'fondu', oui: 'fondu',
  glissement: 'glissement', glisse: 'glissement', slide: 'glissement', push: 'glissement', poussee: 'glissement',
  zoom: 'zoom',
  cube: 'cube',
}
const EFFECT_ALIASES: Record<string, SlideEffect> = {
  fondu: 'fondu', fade: 'fondu', apparition: 'fondu',
  montee: 'montée', monte: 'montée', up: 'montée', 'fly-in': 'montée', glissement: 'montée',
  zoom: 'zoom',
}
const DECOR_ALIASES: Record<string, SlideDecor> = {
  aucun: 'aucun', aucune: 'aucun', non: 'aucun', none: 'aucun',
  bande: 'bande', bandeau: 'bande', band: 'bande',
  degrade: 'dégradé', gradient: 'dégradé',
  formes: 'formes', forme: 'formes', shapes: 'formes', cercles: 'formes',
}
const BUILD_ALIASES: Record<string, boolean> = {
  listes: true, liste: true, oui: true, 'une par une': true, 'un par un': true, incremental: true, yes: true, true: true, points: true,
  non: false, aucune: false, aucun: false, no: false, false: false, none: false,
}

function buildsOf(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v
  if (typeof v !== 'string') return null
  const b = BUILD_ALIASES[fold(v)]
  return b === undefined ? null : b
}

/** Une couleur CSS simple (pas de quoi sortir de la propriete). */
const COLOR_RE = /^(#[0-9a-f]{3,8}|[a-z]{3,20}|(?:rgb|hsl)a?\([\d\s.,%/deg-]+\))$/i

const PAUSE_LINE = /^[ \t]*\.[ \t]\.[ \t]\.[ \t]*$/
const DIRECTIVE_LINE = /^[ \t]*<!--([\s\S]*?)-->[ \t]*$/
const IMAGE_MD = /^[ \t]*!\[(?:fond|bg|background)(?=[\s\]])(?:[ \t]+(gauche|droite|left|right))?[^\]]*\]\(\s*<?([^)>\s]+)>?(?:\s+"[^"]*")?\s*\)[ \t]*$/i
const IMAGE_WIKI = /^[ \t]*!\[\[([^\]|]+)\|[ \t]*(?:fond|bg|background)(?:[ \t]+(gauche|droite|left|right))?[ \t]*\]\][ \t]*$/i

const sideOf = (s: string | undefined): SlideImage['side'] => {
  const v = (s ?? '').toLowerCase()
  return v === 'gauche' || v === 'left' ? 'gauche' : v === 'droite' || v === 'right' ? 'droite' : 'plein'
}

/** Une ligne de reglages `<!-- cle: valeur; cle: valeur -->`, sinon null. */
function directivesOf(line: string): Record<string, string> | null {
  const m = DIRECTIVE_LINE.exec(line)
  if (!m) return null
  const out: Record<string, string> = {}
  for (const part of m[1]!.split(/[;\n]/)) {
    const kv = /^\s*([^:]+?)\s*:\s*(.*?)\s*$/.exec(part)
    if (kv) out[fold(kv[1]!)] = kv[2]!
  }
  return Object.keys(out).length ? out : null
}

/**
 * Retire d'une diapositive ses lignes de reglages et son image de fond (hors
 * code) ; rend le reste, l'image et les reglages.
 */
function slideExtras(markdown: string): { markdown: string; image: SlideImage | null; options: SlideOptions } {
  const options: SlideOptions = { transition: null, effect: null, decor: null, builds: null, background: '' }
  let image: SlideImage | null = null
  let fence = false
  const kept: string[] = []
  for (const line of markdown.split('\n')) {
    if (FENCE.test(line)) fence = !fence
    if (fence || FENCE.test(line)) { kept.push(line); continue }
    const d = directivesOf(line)
    if (d) {
      const get = (...names: string[]) => names.map(n => d[fold(n)]).find(v => v !== undefined)
      options.transition = pick(get('transition'), TRANSITION_ALIASES) ?? options.transition
      options.effect = pick(get('effet', 'effect'), EFFECT_ALIASES) ?? options.effect
      options.decor = pick(get('décor', 'decor'), DECOR_ALIASES) ?? options.decor
      options.builds = buildsOf(get('apparition', 'incremental')) ?? options.builds
      const bg = get('fond', 'background', 'bg')?.trim()
      if (bg && COLOR_RE.test(bg)) options.background = bg
      continue
    }
    if (!image) {
      const md = IMAGE_MD.exec(line)
      if (md) {
        const url = md[2]!
        const markdown = /^(https?:|data:image\/|blob:)/i.test(url) ? `![](${url})` : `![[${safeDecode(url)}]]`
        image = { markdown, side: sideOf(md[1]) }
        continue
      }
      const wiki = IMAGE_WIKI.exec(line)
      if (wiki) { image = { markdown: `![[${wiki[1]!.trim()}]]`, side: sideOf(wiki[2]) }; continue }
    }
    kept.push(line)
  }
  return { markdown: kept.join('\n').trim(), image, options }
}

function safeDecode(s: string): string {
  try { return decodeURI(s) } catch { return s }
}

/**
 * Les etapes d'une diapositive : son contenu coupe aux lignes `. . .` (hors
 * code). Une seule etape quand il n'y en a pas.
 */
export function slideSteps(markdown: string): string[] {
  const out: string[] = []
  let cur: string[] = []
  let fence = false
  for (const line of markdown.split('\n')) {
    if (FENCE.test(line)) fence = !fence
    if (!fence && PAUSE_LINE.test(line)) { out.push(cur.join('\n').trim()); cur = []; continue }
    cur.push(line)
  }
  out.push(cur.join('\n').trim())
  return out.length > 1 ? out.filter((s, i) => i === 0 || s !== '') : out
}

/** La presentation : ses diapositives et ses reglages. */
export function slideDeck(text: string): SlideDeck {
  const fm = findFrontmatter(text)
  const props = fm ? parseFrontmatter(text) as Record<string, unknown> : {}
  const bodyFrom = fm?.end ?? 0
  const seps = slideSeparators(text, bodyFrom)
  const bounds: { from: number; to: number }[] = []
  let at = bodyFrom
  for (const s of seps) {
    bounds.push({ from: at, to: s.from })
    at = Math.min(text.length, s.to + 1)
  }
  bounds.push({ from: at, to: text.length })
  // Une diapositive vide en tete (la note commence par `---`) ne compte pas.
  const kept = bounds.filter((b, i) => i > 0 || text.slice(b.from, b.to).trim() !== '' || bounds.length === 1)
  const slides = kept.map((b, index): Slide => {
    const split = splitNotes(text, b.from, b.to)
    const { markdown, image, options } = slideExtras(split.markdown)
    const h = headingOf(markdown)
    return { index, from: b.from, to: b.to, markdown, notes: split.notes, notesFrom: split.notesFrom, title: h.title, cover: startsWithH1(markdown), image, options }
  })
  const ratio = String(prop(props, ['format', 'ratio', 'taille']) ?? '').replace(/\s/g, '') === '4:3' ? '4:3' : '16:9'
  const footer = prop(props, ['pied', 'pied de page', 'footer'])
  return {
    slides,
    theme: themeOf(prop(props, ['thème', 'theme'])),
    ratio,
    numbers: yes(prop(props, ['numéros', 'numérotation', 'pagination', 'numbers', 'paginate']), true),
    footer: typeof footer === 'string' ? footer : '',
    bodyFrom,
    transition: pick(prop(props, ['transition', 'transitions']), TRANSITION_ALIASES) ?? 'aucune',
    effect: pick(prop(props, ['effet', 'effect', 'effet d’apparition', "effet d'apparition"]), EFFECT_ALIASES) ?? 'fondu',
    decor: pick(prop(props, ['décor', 'decor', 'décoration']), DECOR_ALIASES) ?? 'aucun',
    builds: buildsOf(prop(props, ['apparition', 'apparitions', 'incremental'])) ?? false,
  }
}

/** Rang de la diapositive qui contient la position `pos` du texte. */
export function slideIndexAt(deck: SlideDeck, pos: number): number {
  let index = 0
  for (const s of deck.slides) if (pos >= s.from) index = s.index
  return index
}

/**
 * Ajoute `block` a la fin du contenu d'une diapositive (avant ses notes).
 * Rend le nouveau texte. Hors bornes : erreur.
 */
export function insertIntoSlide(text: string, slideNumber: number, block: string): string {
  const deck = slideDeck(text)
  const slide = deck.slides[slideNumber - 1]
  if (!slide) throw new Error(`Diapositive ${slideNumber} introuvable : la présentation en a ${deck.slides.length}.`)
  const end = slide.notesFrom >= 0 ? slide.notesFrom : slide.to
  const head = text.slice(0, end).replace(/\s+$/, '')
  // La suite : les notes, ou le separateur `---` de la diapositive suivante.
  const rest = text.slice(end).replace(/^\s+/, '')
  const gap = head ? '\n\n' : ''
  return rest ? `${head}${gap}${block.trim()}\n\n${rest}` : `${head}${gap}${block.trim()}\n`
}

// ── Ecriture des reglages (outils d'agent, MCP) ─────────────────────────

/** Reglages de toute la presentation (proprietes). undefined : inchange. */
export interface DeckStyle {
  theme?: SlideTheme
  transition?: SlideTransition
  effect?: SlideEffect
  decor?: SlideDecor
  builds?: boolean
}

/** Reglages d'une diapositive (ligne `<!-- ... -->`). null : retire, undefined : inchange. */
export interface SlideStyle {
  transition?: SlideTransition | null
  effect?: SlideEffect | null
  decor?: SlideDecor | null
  builds?: boolean | null
  background?: string | null
}

/** La valeur ecrite, a partir de ce qu'on donne (alias compris). Erreur si inconnue. */
export function slideStyleValue(kind: 'theme' | 'transition' | 'effect' | 'decor' | 'builds', raw: unknown): SlideTheme | SlideTransition | SlideEffect | SlideDecor | boolean {
  const fail = (list: readonly string[]) => new Error(`Valeur inconnue pour ${kind} : ${String(raw)}. Possibles : ${list.join(', ')}.`)
  if (kind === 'builds') {
    const b = buildsOf(raw)
    if (b === null) throw new Error(`Valeur inconnue pour builds : ${String(raw)} (oui ou non).`)
    return b
  }
  if (kind === 'theme') {
    const s = typeof raw === 'string' ? fold(raw) : ''
    const t = themeOf(raw)
    if (t === 'éditeur' && !['editeur', 'editor', 'app', 'appli', 'auto'].includes(s)) throw fail(SLIDE_THEMES)
    return t
  }
  const table = kind === 'transition' ? TRANSITION_ALIASES : kind === 'effect' ? EFFECT_ALIASES : DECOR_ALIASES
  const v = pick(raw, table as Record<string, string>)
  if (!v) throw fail(kind === 'transition' ? SLIDE_TRANSITIONS : kind === 'effect' ? SLIDE_EFFECTS : SLIDE_DECORS)
  return v as SlideTransition | SlideEffect | SlideDecor
}

const DECK_KEYS: Record<keyof DeckStyle, { names: string[]; write: string }> = {
  theme: { names: ['thème', 'theme'], write: 'thème' },
  transition: { names: ['transition', 'transitions'], write: 'transition' },
  effect: { names: ['effet', 'effect'], write: 'effet' },
  decor: { names: ['décor', 'decor', 'décoration'], write: 'décor' },
  builds: { names: ['apparition', 'apparitions', 'incremental'], write: 'apparition' },
}

/** Change les reglages de la presentation, dans ses proprietes (cle deja ecrite gardee). */
export function setDeckStyle(text: string, style: DeckStyle): string {
  const props = findFrontmatter(text) ? parseFrontmatter(text) as Record<string, unknown> : {}
  let out = text
  for (const [k, v] of Object.entries(style) as [keyof DeckStyle, unknown][]) {
    if (v === undefined) continue
    const spec = DECK_KEYS[k]
    const wanted = new Set(spec.names.map(fold))
    const key = Object.keys(props).find(p => wanted.has(fold(p))) ?? spec.write
    const value = k === 'builds' ? (v ? 'listes' : 'non') : String(v)
    out = setFrontmatterValue(out, key, value)
  }
  return out
}

/** Reecrit les lignes d'une diapositive (son contenu, notes exclues). */
function rewriteSlide(text: string, slideNumber: number, f: (lines: string[]) => string[]): string {
  const deck = slideDeck(text)
  const slide = deck.slides[slideNumber - 1]
  if (!slide) throw new Error(`Diapositive ${slideNumber} introuvable : la présentation en a ${deck.slides.length}.`)
  const end = slide.notesFrom >= 0 ? slide.notesFrom : slide.to
  const lines = f(text.slice(slide.from, end).split('\n'))
  return text.slice(0, slide.from) + lines.join('\n') + text.slice(end)
}

/** Ajoute des lignes en tete d'une diapositive (avant son premier contenu). */
function prepend(lines: string[], head: string[]): string[] {
  if (!head.length) return lines
  const first = lines.findIndex(l => l.trim() !== '')
  if (first < 0) return ['', ...head, '', '']
  return [...lines.slice(0, first), ...head, ...lines.slice(first)]
}

const DIRECTIVE_WRITE: Record<keyof SlideStyle, string> = {
  transition: 'transition', effect: 'effet', decor: 'décor', builds: 'apparition', background: 'fond',
}
const DIRECTIVE_READ: Record<string, keyof SlideStyle> = {
  transition: 'transition', effet: 'effect', effect: 'effect', decor: 'decor', apparition: 'builds', incremental: 'builds',
  fond: 'background', background: 'background', bg: 'background',
}

/**
 * Change les reglages d'une diapositive : une seule ligne `<!-- ... -->` en
 * tete, qui reunit les anciennes. Les autres commentaires restent.
 */
export function setSlideStyle(text: string, slideNumber: number, style: SlideStyle): string {
  if (style.background && !COLOR_RE.test(style.background.trim())) throw new Error(`Couleur de fond invalide : ${style.background} (ex. #1e3a5f).`)
  return rewriteSlide(text, slideNumber, lines => {
    const values = new Map<string, string>()
    const others: Record<string, string> = {}
    const kept: string[] = []
    let fence = false
    for (const line of lines) {
      if (FENCE.test(line)) fence = !fence
      const d = fence || FENCE.test(line) ? null : directivesOf(line)
      if (!d) { kept.push(line); continue }
      for (const [k, v] of Object.entries(d)) {
        const known = DIRECTIVE_READ[k]
        if (known) values.set(DIRECTIVE_WRITE[known], v)
        else others[k] = v
      }
    }
    for (const [k, v] of Object.entries(style) as [keyof SlideStyle, unknown][]) {
      if (v === undefined) continue
      const key = DIRECTIVE_WRITE[k]
      if (v === null || v === '') values.delete(key)
      else values.set(key, k === 'builds' ? (v ? 'listes' : 'non') : String(v).trim())
    }
    // Les cles inconnues d'une ligne de reglages restent (un autre outil les lit peut-etre).
    for (const [k, v] of Object.entries(others)) values.set(k, v)
    const head = values.size ? [`<!-- ${[...values].map(([k, v]) => `${k}: ${v}`).join('; ')} -->`] : []
    return prepend(kept, head)
  })
}

/**
 * Pose (ou retire, avec null) l'image de fond d'une diapositive. Un chemin du
 * vault devient `![[photo.jpg|fond]]`, une adresse web `![fond](https://...)`.
 */
export function setSlideImage(text: string, slideNumber: number, image: { path: string; side?: SlideImage['side'] } | null): string {
  return rewriteSlide(text, slideNumber, lines => {
    let fence = false
    const kept = lines.filter(line => {
      if (FENCE.test(line)) { fence = !fence; return true }
      return fence || !(IMAGE_MD.test(line) || IMAGE_WIKI.test(line))
    })
    if (!image) return kept
    const path = image.path.trim().replace(/[\]|\n]/g, '')
    if (!path) throw new Error('Donnez l’image (chemin dans le vault ou adresse web).')
    const word = image.side && image.side !== 'plein' ? `fond ${image.side}` : 'fond'
    const line = /^(https?:|data:image\/)/i.test(path) ? `![${word}](${path.replace(/[()\s]/g, encodeURIComponent)})` : `![[${path}|${word}]]`
    // Apres la ligne de reglages, s'il y en a une en tete.
    const first = kept.findIndex(l => l.trim() !== '')
    if (first >= 0 && DIRECTIVE_LINE.test(kept[first]!)) return [...kept.slice(0, first + 1), line, ...kept.slice(first + 1)]
    return prepend(kept, [line])
  })
}
