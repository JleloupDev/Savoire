// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Outils d'agent des presentations (ADR-033, ADR-036) : lire le plan d'une
// presentation, regler son allure (theme, transitions, apparitions, decor,
// fond, image de fond), pour toute la presentation ou une diapositive.
//
// Dans l'appli ET sur le pair indexeur (runtime 'server') : ChatGPT et
// Claude s'en servent par le MCP du serveur. Le texte reste celui de la
// note : chaque changement est fait directement, ou propose dans la
// Revision, selon les droits de l'agent. Le format est dans
// plugin-api/slides.ts.
import {
  SLIDE_DECORS, SLIDE_EFFECTS, SLIDE_THEMES, SLIDE_TRANSITIONS,
  changeNoteText, isSlidesNote, noteRef, setDeckStyle, setSlideImage, setSlideStyle, slideDeck, slideSteps, slideStyleValue,
  type DeckStyle, type PluginAPI, type PluginTool, type Slide, type SlideDeck, type SlideStyle,
} from '@savoire/plugin-api'

const RUNTIMES = ['app', 'server'] as const

type Args = Record<string, unknown>

const SIDES = ['plein', 'gauche', 'droite'] as const

/** Les points de premier niveau des listes (hors code) : un clic chacun, si elles apparaissent une par une. */
function listItems(markdown: string): number {
  let fence = false
  let n = 0
  for (const line of markdown.split('\n')) {
    if (/^ {0,3}(`{3,}|~{3,})/.test(line)) { fence = !fence; continue }
    if (!fence && /^ {0,3}(?:[-*+]|\d+[.)])[ \t]+\S/.test(line)) n++
  }
  return n
}

/** Nombre de clics avant la diapositive suivante (estimation, comme le rendu). */
function clicks(deck: SlideDeck, slide: Slide): number {
  const parts = slideSteps(slide.markdown)
  const builds = slide.options.builds ?? deck.builds
  return parts.length - 1 + (builds ? listItems(slide.markdown) : 0)
}

function describeSlide(deck: SlideDeck, s: Slide): string {
  const bits: string[] = []
  if (s.cover) bits.push('diapositive de titre')
  const o = s.options
  if (o.transition) bits.push(`transition ${o.transition}`)
  if (o.effect) bits.push(`effet ${o.effect}`)
  if (o.decor) bits.push(`décor ${o.decor}`)
  if (o.builds !== null) bits.push(`apparition ${o.builds ? 'listes' : 'non'}`)
  if (o.background) bits.push(`fond ${o.background}`)
  if (s.image) bits.push(`image de fond ${s.image.side} : ${s.image.markdown}`)
  const n = clicks(deck, s)
  if (n) bits.push(`${n} clic(s) d’apparition`)
  if (/!\[\[[^\]]+\.anim\b/i.test(s.markdown)) bits.push('animation')
  if (s.notes) bits.push('notes du présentateur')
  return `${s.index + 1}. ${s.title || '(sans titre)'}${bits.length ? ` : ${bits.join(', ')}` : ''}`
}

function deckSummary(deck: SlideDeck): string {
  return `thème ${deck.theme}, format ${deck.ratio}, transition ${deck.transition}, effet ${deck.effect}, décor ${deck.decor}, `
    + `apparition ${deck.builds ? 'listes' : 'non'}`
}

const has = (args: Args, k: string) => args[k] !== undefined && args[k] !== null

export function slidesAgentTools(api: PluginAPI): PluginTool[] {
  return [
    {
      spec: {
        name: 'slides_outline', title: 'Plan d’une présentation', action: 'read', runtimes: [...RUNTIMES],
        description: 'Le plan d’une présentation (note avec la propriété type: slides) : ses réglages, puis chaque diapositive '
          + 'avec son numéro, son titre, sa transition, son fond, ses clics d’apparition, ses notes. '
          + 'Les numéros servent à slides_style et animation_embed.',
        inputSchema: {
          type: 'object',
          properties: { note: { type: 'string', description: 'La présentation (chemin de la note).' } },
          required: ['note'], additionalProperties: false,
        },
      },
      async run(args) {
        const note = noteRef(api, args.note)
        const md = await api.vault.read(note.id)
        if (!isSlidesNote(md)) return { text: `${note.path} n’est pas une présentation (il lui faut la propriété type: slides).`, sources: [{ docId: note.id, path: note.path }] }
        const deck = slideDeck(md)
        const text = `Présentation ${note.path} : ${deck.slides.length} diapositive(s). Réglages : ${deckSummary(deck)}.\n`
          + deck.slides.map(s => describeSlide(deck, s)).join('\n')
        return { text, sources: [{ docId: note.id, path: note.path }] }
      },
    },
    {
      spec: {
        name: 'slides_style', title: 'Allure d’une présentation', action: 'edit', runtimes: [...RUNTIMES],
        description: 'Règle l’allure d’une présentation (note type: slides). Sans slide : toute la présentation (ses propriétés). '
          + 'Avec slide (1 = la première) : cette diapositive seule, qui garde les autres réglages ; null ou "" retire un réglage de la diapositive. '
          + 'transition : passage à la diapositive. builds : les points des listes apparaissent un par un, au clic ; effect : comment ils apparaissent. '
          + 'decor : fond discret aux couleurs du thème. background (diapositive) : couleur de fond. image (diapositive) : image de fond, '
          + 'chemin dans le vault ou adresse web, sur toute la diapositive ou une moitié (image_side), le texte sur l’autre. '
          + 'Pour faire apparaître un passage au clic, écrivez une ligne « . . . » avant lui dans la diapositive (patch_note).',
        inputSchema: {
          type: 'object',
          properties: {
            note: { type: 'string', description: 'La présentation (chemin de la note).' },
            slide: { type: 'integer', description: 'Numéro de la diapositive (sans : toute la présentation).' },
            theme: { type: 'string', enum: [...SLIDE_THEMES], description: 'Couleurs (présentation seulement). éditeur : celles de l’appli.' },
            transition: { type: 'string', enum: [...SLIDE_TRANSITIONS], description: 'Transition à l’entrée d’une diapositive.' },
            effect: { type: 'string', enum: [...SLIDE_EFFECTS], description: 'Effet d’apparition des points et des passages après « . . . ».' },
            decor: { type: 'string', enum: [...SLIDE_DECORS], description: 'Décor : bande, dégradé ou formes.' },
            builds: { type: 'boolean', description: 'Les points des listes apparaissent un par un.' },
            background: { type: 'string', description: 'Couleur de fond de la diapositive (ex. #1e3a5f ; "" pour retirer).' },
            image: { type: 'string', description: 'Image de fond de la diapositive : chemin dans le vault ou adresse https ("" pour retirer).' },
            image_side: { type: 'string', enum: [...SIDES], description: 'Où va l’image : plein (toute la diapositive, par défaut), gauche ou droite.' },
          },
          required: ['note'], additionalProperties: false,
        },
      },
      async run(args, ctx) {
        const note = noteRef(api, args.note)
        const slide = typeof args.slide === 'number' && Number.isInteger(args.slide) ? args.slide : undefined
        const changes: string[] = []
        const r = await changeNoteText(api, ctx, note.id, md => {
          if (!isSlidesNote(md)) throw new Error(`${note.path} n’est pas une présentation : ajoutez-lui la propriété type: slides (set_property).`)
          let out = md
          if (slide === undefined) {
            if (has(args, 'background') || has(args, 'image')) throw new Error('background et image se règlent par diapositive : donnez slide.')
            const style: DeckStyle = {}
            if (has(args, 'theme')) style.theme = slideStyleValue('theme', args.theme) as DeckStyle['theme']
            if (has(args, 'transition')) style.transition = slideStyleValue('transition', args.transition) as DeckStyle['transition']
            if (has(args, 'effect')) style.effect = slideStyleValue('effect', args.effect) as DeckStyle['effect']
            if (has(args, 'decor')) style.decor = slideStyleValue('decor', args.decor) as DeckStyle['decor']
            if (has(args, 'builds')) style.builds = slideStyleValue('builds', args.builds) as boolean
            if (!Object.keys(style).length) throw new Error('Rien à régler : donnez theme, transition, effect, decor ou builds.')
            for (const [k, v] of Object.entries(style)) changes.push(`${k} ${v}`)
            return setDeckStyle(out, style)
          }
          const deck = slideDeck(md)
          if (slide < 1 || slide > deck.slides.length) {
            const list = deck.slides.map(s => `${s.index + 1}${s.title ? ` (${s.title})` : ''}`).join(', ')
            throw new Error(`Diapositive ${slide} introuvable : ${deck.slides.length} diapositive(s) : ${list}.`)
          }
          if (has(args, 'theme')) throw new Error('Le thème vaut pour toute la présentation : sans slide. Pour une diapositive : background.')
          const style: SlideStyle = {}
          const value = <K extends 'transition' | 'effect' | 'decor'>(k: K) => {
            if (!(k in args)) return
            const raw = args[k]
            style[k] = (raw === null || raw === '' ? null : slideStyleValue(k, raw)) as SlideStyle[K]
          }
          value('transition'); value('effect'); value('decor')
          if ('builds' in args) style.builds = args.builds === null ? null : slideStyleValue('builds', args.builds) as boolean
          if ('background' in args) style.background = typeof args.background === 'string' && args.background.trim() ? args.background.trim() : null
          const touched = Object.keys(style).length > 0
          if (touched) {
            out = setSlideStyle(out, slide, style)
            for (const [k, v] of Object.entries(style)) changes.push(v === null ? `${k} retiré` : `${k} ${v}`)
          }
          if ('image' in args) {
            const path = typeof args.image === 'string' ? args.image.trim() : ''
            const side = SIDES.find(s => s === args.image_side) ?? 'plein'
            out = setSlideImage(out, slide, path ? { path, side } : null)
            changes.push(path ? `image de fond ${side} ${path}` : 'image de fond retirée')
          } else if (has(args, 'image_side')) {
            // Changer de cote seulement : l'image deja la.
            const current = slideDeck(out).slides[slide - 1]!.image
            if (!current) throw new Error(`La diapositive ${slide} n’a pas d’image de fond : donnez image.`)
            const path = /^!\[\[([^\]]+)\]\]$/.exec(current.markdown)?.[1] ?? /\((.+)\)$/.exec(current.markdown)?.[1] ?? ''
            const side = SIDES.find(s => s === args.image_side) ?? 'plein'
            out = setSlideImage(out, slide, { path, side })
            changes.push(`image de fond ${side}`)
          } else if (!touched) {
            throw new Error('Rien à régler : donnez transition, effect, decor, builds, background ou image.')
          }
          return out
        }, 'allure de la présentation')
        const where = slide !== undefined ? `diapositive ${slide} de ${note.path}` : note.path
        const text = r === 'proposed' ? `Réglages proposés pour ${where} (Révision) : ${changes.join(', ')}.`
          : r === 'unchanged' ? `Rien n’a changé (${where} avait déjà ces réglages).`
            : `Réglé pour ${where} : ${changes.join(', ')}.`
        return { text, sources: [{ docId: note.id, path: note.path }] }
      },
    },
  ]
}
