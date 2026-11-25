// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Outils d'agent des animations (ADR-033) : lister, lire, creer, modifier
// une animation (.anim), et l'integrer dans une note ou une diapositive.
//
// Dans l'appli ET sur le pair indexeur (runtime 'server') : ChatGPT et
// Claude s'en servent par le MCP du serveur. Une animation est un texte
// partage, comme une note : chaque changement est fait directement, ou
// propose dans la Revision (proposition de texte), selon les droits de
// l'agent. Le format est dans format.ts.
import {
  changeNoteText, insertIntoSlide, isSlidesNote, noteRef, slideDeck,
  type PluginAPI, type PluginTool, type ToolParamSchema,
} from '@savoire/plugin-api'
import { animEmbedText, animationParts, checkKeyframes, composeAnimation, replaceParts, type AnimParts } from './format'

const RUNTIMES = ['app', 'server'] as const
const MAX_SOURCE = 200_000

type Args = Record<string, unknown>

const animPath = (raw: string): string => (/\.anim$/i.test(raw) ? raw : `${raw}.anim`)

function animationRef(api: PluginAPI, path: unknown): { id: string; path: string } {
  const raw = typeof path === 'string' ? path.trim().replace(/^\/+/, '') : ''
  if (!raw) throw new Error('Donnez l’animation (chemin .anim).')
  const wanted = animPath(raw)
  const tree = api.vault.getFileTree?.() ?? []
  const hit = tree.find(f => f.docId === raw || f.path.toLowerCase() === wanted.toLowerCase())
    ?? tree.find(f => f.path.toLowerCase().endsWith(`/${wanted.toLowerCase()}`))
  if (hit) return { id: hit.docId, path: hit.path }
  const id = api.vault.resolveDocumentId(wanted)
  if (!id) throw new Error(`Animation introuvable : ${wanted}. Voir animation_list.`)
  return { id, path: wanted }
}

const str = (args: Args, k: string): string | undefined => (typeof args[k] === 'string' ? args[k] as string : undefined)

/** Les parties donnees par l'agent (rien : undefined partout). */
function partsOf(args: Args): Partial<AnimParts> {
  const out: Partial<AnimParts> = {}
  for (const k of ['html', 'css', 'script'] as const) { const v = str(args, k); if (v !== undefined) out[k] = v }
  if (args.keyframes !== undefined) {
    let k = args.keyframes
    if (typeof k === 'string') {
      try { k = JSON.parse(k) } catch { throw new Error('keyframes : JSON invalide.') }
    }
    const bad = checkKeyframes(k)
    if (bad) throw new Error(bad)
    out.keyframes = k
  }
  return out
}

function checkSize(text: string): string {
  if (text.length > MAX_SOURCE) throw new Error(`Animation trop longue (${text.length} caractères, ${MAX_SOURCE} au plus).`)
  if (!text.trim()) throw new Error('L’animation est vide : donnez html et script, ou source.')
  return text
}

/** L'id d'un document tout juste cree (l'arborescence suit un peu apres dans l'appli). */
async function idAfterCreate(api: PluginAPI, path: string, timeoutMs = 5000): Promise<string> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const id = api.vault.resolveDocumentId(path) ?? (api.vault.getFileTree?.() ?? []).find(f => f.path === path)?.docId
    if (id) return id
    if (Date.now() > until) throw new Error(`Animation introuvable après sa création : ${path}.`)
    await new Promise(res => setTimeout(res, 50))
  }
}

// ── Schemas ─────────────────────────────────────────────────────────────

const PATH: ToolParamSchema = { type: 'string', description: 'Animation : son chemin .anim (l’extension peut manquer).' }
const HTML: ToolParamSchema = { type: 'string', description: 'La scène : HTML et SVG (sans <html> ni <body>). Ex. <div class="balle"></div>.' }
const CSS: ToolParamSchema = { type: 'string', description: 'Les styles de la scène (CSS, sans <style>). Donnez une hauteur à la scène.' }
const SCRIPT: ToolParamSchema = {
  type: 'string',
  description: 'Le code JavaScript (sans <script>), avec anime.js v4 : « anime » contient animate, createTimeline, stagger, svg, utils… '
    + 'Ajoutez les animations à « timeline » (déjà créée, ne pas en créer une autre) pour que la lecture, la pause et les commentaires au timecode marchent : '
    + 'timeline.add(\'.balle\', { x: 240, duration: 800, ease: \'outQuad\' }).add(\'.titre\', { opacity: [0, 1] }, \'-=200\'). '
    + 'Syntaxe v4 : ease (pas easing), x / y / rotate / scale, loop sur la frise. Pas de réseau : pas de fetch ni d’image distante.',
}
const KEYFRAMES: ToolParamSchema = {
  type: 'object',
  description: 'Images clés en JSON (facultatif), ajoutées à la frise avant le code : { "tracks": [ { "target": ".balle", "at": 0, '
    + '"keyframes": [ { "x": 240, "duration": 800 }, { "y": 80 } ], "ease": "outQuad" } ] }. Chaque piste = timeline.add(target, reste, at).',
}

export function animationAgentTools(api: PluginAPI): PluginTool[] {
  return [
    {
      spec: {
        name: 'animation_list', title: 'Lister les animations', action: 'read', runtimes: [...RUNTIMES],
        description: 'Les animations du vault (fichiers .anim, anime.js), éventuellement d’un dossier.',
        inputSchema: { type: 'object', properties: { folder: { type: 'string', description: 'Dossier (facultatif).' } }, additionalProperties: false },
      },
      async run(args) {
        const folder = typeof args.folder === 'string' ? args.folder.trim().replace(/^\/+|\/+$/g, '') : ''
        const prefix = folder ? `${folder.toLowerCase()}/` : ''
        const all = (api.vault.getFileTree?.() ?? [])
          .filter(f => /\.anim$/i.test(f.path) && !f.path.startsWith('.trash/') && f.path.toLowerCase().startsWith(prefix))
          .sort((a, b) => a.path.localeCompare(b.path))
        if (!all.length) return { text: folder ? `Aucune animation dans ${folder}.` : 'Aucune animation dans ce vault.' }
        const shown = all.slice(0, 200)
        return {
          text: `${all.length} animation(s) :\n${shown.map(f => `- ${f.path}`).join('\n')}${all.length > shown.length ? `\n… et ${all.length - shown.length} autre(s).` : ''}`,
          sources: shown.slice(0, 20).map(f => ({ docId: f.docId, path: f.path })),
        }
      },
    },
    {
      spec: {
        name: 'animation_read', title: 'Lire une animation', action: 'read', runtimes: [...RUNTIMES],
        description: 'Le texte d’une animation (.anim) : styles, scène, images clés et code anime.js.',
        inputSchema: { type: 'object', properties: { path: PATH }, required: ['path'], additionalProperties: false },
      },
      async run(args) {
        const a = animationRef(api, args.path)
        const source = await api.vault.read(a.id)
        const parts = animationParts(source)
        const tracks = (parts.keyframes as { tracks?: unknown[] } | null)?.tracks
        const summary = [
          `Animation ${a.path}`,
          `scène : ${parts.html ? `${parts.html.length} caractères` : 'vide'}, styles : ${parts.css.length}, code : ${parts.script.length}, images clés : ${Array.isArray(tracks) ? `${tracks.length} piste(s)` : 'aucune'}.`,
        ].join('\n')
        return { text: `${summary}\n\n${source || '(vide)'}`, sources: [{ docId: a.id, path: a.path }] }
      },
    },
    {
      spec: {
        name: 'animation_create', title: 'Créer une animation', action: 'create', runtimes: [...RUNTIMES],
        description: 'Crée une animation (fichier .anim) jouée par anime.js v4 dans un cadre isolé : une scène HTML/SVG, ses styles, '
          + 'des images clés et du code. Pour la montrer dans une note ou une diapositive : animation_embed. '
          + 'Une animation se crée toujours ainsi, jamais par une note.',
        inputSchema: {
          type: 'object',
          properties: {
            path: PATH, html: HTML, css: CSS, script: SCRIPT, keyframes: KEYFRAMES,
            source: { type: 'string', description: 'Ou : le texte complet du fichier (à la place de html, css, script et keyframes).' },
          },
          required: ['path'], additionalProperties: false,
        },
      },
      async run(args, ctx) {
        const raw = typeof args.path === 'string' ? args.path.trim().replace(/^\/+/, '') : ''
        if (!raw) throw new Error('Donnez le chemin de l’animation.')
        const path = animPath(raw)
        const source = checkSize(typeof args.source === 'string' ? args.source : composeAnimation(partsOf(args)))
        if (ctx.mode === 'propose') throw new Error('En mode proposition, un agent ne crée pas d’animation : il faut le droit de créer en direct.')
        if (api.vault.resolveDocumentId(path) || (api.vault.getFileTree?.() ?? []).some(f => f.path.toLowerCase() === path.toLowerCase())) {
          throw new Error(`Un document existe déjà : ${path}. Pour le changer : animation_update.`)
        }
        if (typeof api.vault.createFile !== 'function' || typeof api.vault.editText !== 'function') throw new Error('Ce vault ne permet pas de créer de document.')
        const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
        if (folder) await api.vault.createFolder?.(folder)
        await api.vault.createFile(path)
        const id = await idAfterCreate(api, path)
        await api.vault.editText(id, () => source)
        return { text: `Animation créée : ${path}. Pour l’intégrer : animation_embed (note, ou diapositive d’une présentation).`, sources: [{ docId: id, path }] }
      },
    },
    {
      spec: {
        name: 'animation_update', title: 'Modifier une animation', action: 'edit', runtimes: [...RUNTIMES],
        description: 'Modifie une animation (.anim). Au choix : remplacer des parties (html, css, script, keyframes : les autres restent), '
          + 'remplacer un passage exact (find puis replace), ou tout le texte (source). Lisez-la d’abord (animation_read).',
        inputSchema: {
          type: 'object',
          properties: {
            path: PATH, html: HTML, css: CSS, script: SCRIPT, keyframes: KEYFRAMES,
            find: { type: 'string', description: 'Passage exact à remplacer (une seule occurrence).' },
            replace: { type: 'string', description: 'Texte qui remplace find.' },
            source: { type: 'string', description: 'Ou : le nouveau texte complet.' },
          },
          required: ['path'], additionalProperties: false,
        },
      },
      async run(args, ctx) {
        const a = animationRef(api, args.path)
        const parts = partsOf(args)
        const find = str(args, 'find')
        const source = str(args, 'source')
        if (source === undefined && find === undefined && !Object.keys(parts).length) throw new Error('Rien à changer : donnez html, css, script, keyframes, find/replace ou source.')
        const r = await changeNoteText(api, ctx, a.id, current => {
          let next = current
          if (source !== undefined) next = source
          else if (find !== undefined) {
            const at = current.indexOf(find)
            if (!find || at < 0) throw new Error('Passage introuvable (find) : relisez l’animation.')
            if (current.indexOf(find, at + 1) >= 0) throw new Error('Passage trouvé plusieurs fois (find) : donnez-en plus.')
            next = current.slice(0, at) + (str(args, 'replace') ?? '') + current.slice(at + find.length)
          }
          if (Object.keys(parts).length) next = replaceParts(next, parts)
          return checkSize(next)
        }, 'animation modifiée')
        const text = r === 'proposed' ? `Modification proposée dans ${a.path} (Révision).` : r === 'unchanged' ? `Rien n’a changé dans ${a.path}.` : `Animation modifiée : ${a.path}.`
        return { text, sources: [{ docId: a.id, path: a.path }] }
      },
    },
    {
      spec: {
        name: 'animation_embed', title: 'Intégrer une animation', action: 'edit', runtimes: [...RUNTIMES],
        description: 'Intègre une animation dans une note : ![[nom.anim]] (elle se joue quand elle est visible). '
          + 'Dans une présentation (note avec la propriété type: slides), slide vise une diapositive : 1 = la première ; '
          + 'les diapositives sont séparées par une ligne --- précédée d’une ligne vide. Sans slide : à la fin de la note.',
        inputSchema: {
          type: 'object',
          properties: {
            note: { type: 'string', description: 'Note (ou présentation) qui reçoit l’animation.' },
            animation: PATH,
            slide: { type: 'integer', description: 'Numéro de la diapositive (présentation seulement).' },
            loop: { type: 'boolean', description: 'Rejouer en boucle.' },
            autoplay: { type: 'boolean', description: 'Démarrer seule quand elle est visible (oui par défaut).' },
            controls: { type: 'boolean', description: 'Barre de lecture (oui par défaut ; non pour une diapositive épurée).' },
          },
          required: ['note', 'animation'], additionalProperties: false,
        },
      },
      async run(args, ctx) {
        const a = animationRef(api, args.animation)
        const note = noteRef(api, args.note)
        const name = a.path.split('/').pop() ?? a.path
        const block = animEmbedText(name, {
          loop: args.loop === true,
          ...(args.autoplay === false ? { autoplay: false } : {}),
          ...(args.controls === false ? { controls: false } : {}),
        })
        const slide = typeof args.slide === 'number' && Number.isInteger(args.slide) ? args.slide : undefined
        const r = await changeNoteText(api, ctx, note.id, md => {
          if (slide !== undefined) {
            if (!isSlidesNote(md)) throw new Error(`${note.path} n’est pas une présentation : ajoutez-lui la propriété type: slides, ou intégrez sans slide.`)
            const deck = slideDeck(md)
            if (slide > deck.slides.length) {
              const list = deck.slides.map(s => `${s.index + 1}${s.title ? ` (${s.title})` : ''}`).join(', ')
              throw new Error(`Diapositive ${slide} introuvable : ${deck.slides.length} diapositive(s) : ${list}.`)
            }
            return insertIntoSlide(md, slide, block)
          }
          const sep = md === '' || md.endsWith('\n\n') ? '' : md.endsWith('\n') ? '\n' : '\n\n'
          return `${md}${sep}${block}\n`
        }, `animation ${name}`)
        const where = slide !== undefined ? `la diapositive ${slide} de ${note.path}` : note.path
        const text = r === 'proposed' ? `Animation proposée dans ${where} (Révision).` : `Animation intégrée dans ${where} : ${block}.`
        return { text, sources: [{ docId: note.id, path: note.path }, { docId: a.id, path: a.path }] }
      },
    },
  ]
}
