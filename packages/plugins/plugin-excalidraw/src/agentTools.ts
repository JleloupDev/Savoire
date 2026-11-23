// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Outils d'agent d'Excalidraw (ADR-033) : lister et lire les dessins, y
// ajouter des formes, les relier, les deplacer, les supprimer, poser un
// schema place tout seul, creer un dessin.
//
// Dans l'appli ET sur le pair indexeur (runtime 'server') : ChatGPT et
// Claude s'en servent par le MCP du serveur. La scene est un arbre partage
// (openTree) ; chaque changement est fait directement, ou propose dans la
// Revision (type « excalidraw.scene », le meme que le mode suggestion).
// La geometrie est dans scene.ts.
import { type PluginAPI, type PluginTool, type ToolContext, type ToolParamSchema, type ToolResult } from '@savoire/plugin-api'
import { SceneBinding, applyScenePatch, type SceneElement, type ScenePatch } from './binding'
import {
  NODE_SHAPES, SHAPES, STROKE_STYLES, SceneDraft, centerOf, edgePoint, freeSpot, layoutDiagram, shapeElements,
  type DiagramDirection, type DiagramEdge, type DiagramNode, type NodeShape, type ShapeInput, type ShapeType, type StrokeStyle,
} from './scene'

export { shapeElements, type ShapeInput } from './scene'

/** Type de proposition d'un dessin (Revision) : des elements changes. */
export const SCENE_PROPOSAL = 'excalidraw.scene'

const RUNTIMES = ['app', 'server'] as const
const MAX_SHAPES = 100
const MAX_LINES = 400

// ── Lire ──────────────────────────────────────────────────────────────────

const r = (n: unknown): number => Math.round(Number(n) || 0)

/** Une ligne par element visible : forme, identifiant, position, taille, liens, texte. */
export function describeScene(elements: readonly SceneElement[]): string {
  const live = elements.filter(e => !e.isDeleted)
  if (!live.length) return 'Dessin vide.'
  const labels = new Map<string, string>()
  for (const e of live) if (e.type === 'text' && typeof e.containerId === 'string') labels.set(e.containerId, String(e.text ?? ''))
  const shown = live.filter(e => !(e.type === 'text' && typeof e.containerId === 'string' && labels.has(e.containerId)))
  const scribbles = shown.filter(e => e.type === 'freedraw').length
  const lines = shown.filter(e => e.type !== 'freedraw').slice(0, MAX_LINES).map(e => {
    const text = e.type === 'text' ? String(e.text ?? '') : e.type === 'frame' ? String(e.name ?? '') : labels.get(e.id)
    const from = (e.startBinding as { elementId?: string } | null)?.elementId
    const to = (e.endBinding as { elementId?: string } | null)?.elementId
    const link = from || to ? `, de ${from ?? '(libre)'} vers ${to ?? '(libre)'}` : ''
    const look = [
      e.strokeColor && e.strokeColor !== '#1e1e1e' ? `trait ${String(e.strokeColor)}` : '',
      e.backgroundColor && e.backgroundColor !== 'transparent' ? `fond ${String(e.backgroundColor)}` : '',
      e.strokeStyle === 'dashed' ? 'tirets' : e.strokeStyle === 'dotted' ? 'pointillés' : '',
    ].filter(Boolean)
    return `- ${String(e.type)} ${e.id} à (${r(e.x)}, ${r(e.y)}), ${r(e.width)}×${r(e.height)}${link}${look.length ? ` [${look.join(', ')}]` : ''}${text ? ` : « ${text.replace(/\n/g, ' ')} »` : ''}`
  })
  const more = shown.length - scribbles - lines.length
  return [
    `${shown.length} élément(s) :`,
    ...lines,
    ...(more > 0 ? [`… et ${more} autre(s).`] : []),
    ...(scribbles ? [`(${scribbles} tracé(s) à main levée)`] : []),
  ].join('\n')
}

// ── Arguments ─────────────────────────────────────────────────────────────

type Args = Record<string, unknown>

const numArg = (s: Args, k: string): number | undefined => (typeof s[k] === 'number' && Number.isFinite(s[k]) ? s[k] as number : undefined)
const strArg = (s: Args, k: string): string | undefined => (typeof s[k] === 'string' ? s[k] as string : undefined)
const styleArg = (s: Args): StrokeStyle | undefined => (STROKE_STYLES as readonly string[]).includes(String(s.style)) ? s.style as StrokeStyle : undefined

interface ShapeArg extends Omit<ShapeInput, 'x' | 'y'> {
  x?: number
  y?: number
  /** Nom donne par l'IA pour relier la forme dans le meme appel. */
  key?: string
  from?: string
  to?: string
}

function parseShapes(v: unknown, allowEmpty = false): ShapeArg[] {
  if (!Array.isArray(v) || !v.length) {
    if (allowEmpty && (v === undefined || (Array.isArray(v) && !v.length))) return []
    throw new Error('Donnez au moins une forme (shapes).')
  }
  if (v.length > MAX_SHAPES) throw new Error(`${MAX_SHAPES} formes au plus par appel.`)
  return v.map((raw, i) => {
    const s = (raw ?? {}) as Args
    const type = String(s.type ?? '') as ShapeType
    if (!SHAPES.includes(type)) throw new Error(`Forme ${i + 1} : type parmi ${SHAPES.join(', ')}.`)
    const x = numArg(s, 'x'); const y = numArg(s, 'y')
    const from = strArg(s, 'from'); const to = strArg(s, 'to')
    const linked = (type === 'arrow' || type === 'line') && (from || to)
    if ((x === undefined) !== (y === undefined) && !linked) throw new Error(`Forme ${i + 1} : x et y vont ensemble.`)
    if ((from || to) && type !== 'arrow' && type !== 'line') throw new Error(`Forme ${i + 1} : from et to sont pour une flèche (arrow) ou un trait (line).`)
    const out: ShapeArg = { type }
    for (const k of ['x', 'y', 'width', 'height', 'fontSize'] as const) { const n = numArg(s, k); if (n !== undefined) out[k] = n }
    for (const k of ['text', 'color', 'fill', 'key', 'from', 'to'] as const) { const t = strArg(s, k); if (t !== undefined) out[k] = t }
    const style = styleArg(s)
    if (style) out.style = style
    return out
  })
}

/** Un identifiant d'element, ou une cle donnee dans le meme appel. */
function resolver(draft: SceneDraft, keys: Map<string, string>) {
  return (ref: string): string => {
    const id = keys.get(ref) ?? ref
    if (!draft.get(id)) throw new Error(`Élément introuvable : ${ref}. Voir drawing_read.`)
    return id
  }
}

/**
 * Ajoute des formes au brouillon. Une forme sans (x, y) se place a droite
 * du dessin ; une fleche avec from / to s'attache aux formes visees.
 */
function addShapes(draft: SceneDraft, shapes: readonly ShapeArg[]): Map<string, string> {
  const keys = new Map<string, string>()
  const spot = freeSpot(draft.live())
  let column = spot.y
  const links: { id: string; from?: string; to?: string }[] = []
  for (const s of shapes) {
    let x = s.x, y = s.y
    if (x === undefined || y === undefined) {
      x = spot.x
      y = column
      column += (s.height ?? 80) + 40
    }
    const els = shapeElements({ ...s, x, y } as ShapeInput)
    draft.add(...els)
    const id = els[0]!.id
    if (s.key) {
      if (keys.has(s.key)) throw new Error(`Clé en double : ${s.key}.`)
      keys.set(s.key, id)
    }
    if (s.from || s.to) links.push({ id, ...(s.from ? { from: s.from } : {}), ...(s.to ? { to: s.to } : {}) })
  }
  // Les fleches s'attachent une fois toutes les formes posees (une cle peut viser une forme d'apres).
  const find = resolver(draft, keys)
  for (const l of links) {
    if (l.from) draft.connect(l.id, 'start', find(l.from))
    if (l.to) draft.connect(l.id, 'end', find(l.to))
  }
  return keys
}

const keysLine = (keys: Map<string, string>): string =>
  keys.size ? `\nIdentifiants : ${[...keys].map(([k, id]) => `${k} → ${id}`).join(', ')}.` : ''

function parseNodes(v: unknown): DiagramNode[] {
  if (!Array.isArray(v) || !v.length) throw new Error('Donnez au moins un nœud (nodes).')
  if (v.length > MAX_SHAPES) throw new Error(`${MAX_SHAPES} nœuds au plus par appel.`)
  const seen = new Set<string>()
  return v.map((raw, i) => {
    const s = (raw ?? {}) as Args
    const key = strArg(s, 'key')?.trim() || strArg(s, 'id')?.trim()
    if (!key) throw new Error(`Nœud ${i + 1} : key attendue.`)
    if (seen.has(key)) throw new Error(`Clé en double : ${key}.`)
    seen.add(key)
    const shape = (NODE_SHAPES as readonly string[]).includes(String(s.shape)) ? s.shape as NodeShape : undefined
    return { key, text: strArg(s, 'text') ?? key, ...(shape ? { shape } : {}), ...(strArg(s, 'color') ? { color: strArg(s, 'color')! } : {}), ...(strArg(s, 'fill') ? { fill: strArg(s, 'fill')! } : {}) }
  })
}

function parseEdges(v: unknown): DiagramEdge[] {
  if (v === undefined) return []
  if (!Array.isArray(v)) throw new Error('edges : une liste de liens { from, to }.')
  if (v.length > MAX_SHAPES * 2) throw new Error(`${MAX_SHAPES * 2} liens au plus par appel.`)
  return v.map((raw, i) => {
    const s = (raw ?? {}) as Args
    const from = strArg(s, 'from'); const to = strArg(s, 'to')
    if (!from || !to) throw new Error(`Lien ${i + 1} : from et to attendus.`)
    const style = styleArg(s)
    return { from, to, ...(strArg(s, 'text') ? { text: strArg(s, 'text')! } : {}), ...(strArg(s, 'color') ? { color: strArg(s, 'color')! } : {}), ...(style ? { style } : {}) }
  })
}

// ── Dessin vise ───────────────────────────────────────────────────────────

const drawingPath = (raw: string): string => (/\.excalidraw$/i.test(raw) ? raw : `${raw}.excalidraw`)

function drawingRef(api: PluginAPI, path: unknown): { id: string; path: string } {
  const raw = typeof path === 'string' ? path.trim().replace(/^\/+/, '') : ''
  if (!raw) throw new Error('Donnez le dessin (chemin .excalidraw).')
  const wanted = drawingPath(raw)
  const hit = (api.vault.getFileTree?.() ?? []).find(f => f.docId === raw || f.path.toLowerCase() === wanted.toLowerCase())
  if (hit) return { id: hit.docId, path: hit.path }
  const id = api.vault.resolveDocumentId(wanted)
  if (!id) throw new Error(`Dessin introuvable : ${wanted}. Voir drawing_list.`)
  return { id, path: wanted }
}

const readElements = (tree: Parameters<typeof applyScenePatch>[0]): SceneElement[] =>
  new SceneBinding({ tree, getElements: () => null, applyElements: () => {}, hasFile: () => false, addFiles: () => {} }).readElements()

async function withTree<T>(api: PluginAPI, docId: string, fn: (tree: Parameters<typeof applyScenePatch>[0]) => T | Promise<T>): Promise<T> {
  if (!api.vault.openTree) throw new Error('Dessin indisponible sans synchronisation du vault.')
  const tree = await api.vault.openTree(docId)
  try {
    return await fn(tree)
  } finally {
    api.vault.closeTree?.(docId)
  }
}

interface EditOutcome {
  /** Ce qui est fait, pour la phrase rendue (« 3 forme(s) ajoutée(s) »...). */
  done: string
  proposed: string
  /** Libelle de la proposition dans la Revision. */
  note: string
  /** Ajoute a la reponse (identifiants...). */
  extra?: string
}

/** Lit la scene, la modifie, puis ecrit le changement ou le propose. */
async function editScene(api: PluginAPI, d: { id: string; path: string }, ctx: ToolContext, build: (draft: SceneDraft) => EditOutcome): Promise<ToolResult> {
  const sources = [{ docId: d.id, path: d.path }]
  return withTree(api, d.id, async tree => {
    const draft = new SceneDraft(readElements(tree))
    const o = build(draft)
    const patch: ScenePatch = draft.patch()
    if (!patch.elements.length) return { text: `Rien à changer dans ${d.path}.`, sources }
    if (ctx.mode === 'propose') {
      if (!api.review) throw new Error('Révision indisponible.')
      await api.review.propose(d.id, SCENE_PROPOSAL, patch, `${ctx.actor.agentName} : ${o.note}`)
      return { text: `${o.proposed} dans ${d.path} (Révision).${o.extra ?? ''}`, sources }
    }
    const { conflicts } = applyScenePatch(tree, patch)
    if (conflicts.length) throw new Error('Le dessin a changé : réessayez.')
    return { text: `${o.done} ${d.path}.${o.extra ?? ''}`, sources }
  })
}

const summary = (draft: SceneDraft): string => {
  const c = draft.counts()
  return [c.added && `${c.added} ajouté(s)`, c.changed && `${c.changed} modifié(s)`, c.removed && `${c.removed} supprimé(s)`].filter(Boolean).join(', ') || 'aucun changement'
}

// ── Schemas des parametres ────────────────────────────────────────────────

const PATH: ToolParamSchema = { type: 'string', description: 'Dessin : son chemin .excalidraw (l’extension peut manquer).' }
const COLOR = 'Couleur du trait et du texte : #rrggbb ou un nom (noir, rouge, vert, bleu, orange, jaune, violet, rose, gris).'
const FILL = 'Fond d’une forme : #rrggbb, un nom (rouge, vert, bleu, jaune, orange, violet, rose, gris, blanc) ou transparent.'
const STYLE: ToolParamSchema = { type: 'string', enum: [...STROKE_STYLES], description: 'Trait : plein, tirets, pointillés.' }

const SHAPE_ITEM: ToolParamSchema = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: [...SHAPES] },
    x: { type: 'number', description: 'Coin haut-gauche (une flèche : son départ). Sans x ni y, la forme se place à droite du dessin.' },
    y: { type: 'number' },
    width: { type: 'number', description: 'Une flèche va de (x, y) à (x+width, y+height).' },
    height: { type: 'number' },
    text: { type: 'string', description: 'Texte, ou étiquette dans la forme ou sur la flèche.' },
    color: { type: 'string', description: COLOR },
    fill: { type: 'string', description: FILL },
    style: STYLE,
    fontSize: { type: 'number', description: 'Taille du texte (20 par défaut).' },
    key: { type: 'string', description: 'Nom libre de la forme, pour la viser avec from / to dans le même appel.' },
    from: { type: 'string', description: 'Flèche : forme de départ (identifiant, ou key d’une forme de cet appel). La flèche s’y attache.' },
    to: { type: 'string', description: 'Flèche : forme d’arrivée (identifiant ou key).' },
  },
}

// ── Outils ────────────────────────────────────────────────────────────────

export function excalidrawAgentTools(api: PluginAPI): PluginTool[] {
  return [
    {
      spec: {
        name: 'drawing_read', title: 'Lire un dessin', action: 'read', runtimes: [...RUNTIMES],
        description: 'Les éléments d’un dessin Excalidraw, un par ligne : type, identifiant, position, taille, flèches (de … vers …), couleurs, texte. Les identifiants servent à drawing_update, drawing_delete et aux flèches (from / to).',
        inputSchema: { type: 'object', properties: { path: PATH }, required: ['path'], additionalProperties: false },
      },
      async run(args) {
        const d = drawingRef(api, args.path)
        const elements = await withTree(api, d.id, readElements)
        return { text: `# ${d.path}\n\n${describeScene(elements)}`, sources: [{ docId: d.id, path: d.path }] }
      },
    },
    {
      spec: {
        name: 'drawing_add', title: 'Ajouter au dessin', action: 'edit', runtimes: [...RUNTIMES],
        description: 'Ajoute des formes à un dessin Excalidraw : rectangle, ellipse, diamond (losange), text, arrow, line. Une flèche avec from / to s’attache aux formes visées et se place seule (x, y inutiles). Donnez une key à une forme pour la relier dans le même appel. Pour un schéma de boîtes et de flèches, drawing_diagram place tout seul.',
        inputSchema: {
          type: 'object',
          properties: { path: PATH, shapes: { type: 'array', description: 'Les formes à ajouter, dans l’ordre (les dernières dessus).', items: SHAPE_ITEM } },
          required: ['path', 'shapes'], additionalProperties: false,
        },
      },
      async run(args, ctx) {
        const d = drawingRef(api, args.path)
        const shapes = parseShapes(args.shapes)
        return editScene(api, d, ctx, draft => {
          const keys = addShapes(draft, shapes)
          const n = shapes.length
          return { done: `${n} forme(s) ajoutée(s) à`, proposed: `${n} forme(s) proposée(s)`, note: `${n} forme(s)`, extra: keysLine(keys) }
        })
      },
    },
    {
      spec: {
        name: 'drawing_update', title: 'Modifier le dessin', action: 'edit', runtimes: [...RUNTIMES],
        description: 'Modifie des éléments d’un dessin Excalidraw, par identifiant (voir drawing_read) : déplacer (x, y, ou dx, dy), redimensionner (width, height), changer le texte, les couleurs, le trait, ou rattacher une flèche (from, to ; "" pour la détacher). Le texte d’une forme et les flèches attachées suivent.',
        inputSchema: {
          type: 'object',
          properties: {
            path: PATH,
            changes: {
              type: 'array', description: 'Un changement par élément.',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'Identifiant de l’élément.' },
                  x: { type: 'number' }, y: { type: 'number' },
                  dx: { type: 'number', description: 'Déplacement relatif.' }, dy: { type: 'number' },
                  width: { type: 'number' }, height: { type: 'number' },
                  text: { type: 'string', description: 'Nouveau texte ("" : l’enlever).' },
                  color: { type: 'string', description: COLOR }, fill: { type: 'string', description: FILL }, style: STYLE,
                  from: { type: 'string', description: 'Flèche : nouvelle forme de départ ("" : détacher).' },
                  to: { type: 'string', description: 'Flèche : nouvelle forme d’arrivée ("" : détacher).' },
                },
              },
            },
          },
          required: ['path', 'changes'], additionalProperties: false,
        },
      },
      async run(args, ctx) {
        const d = drawingRef(api, args.path)
        if (!Array.isArray(args.changes) || !args.changes.length) throw new Error('Donnez au moins un changement (changes).')
        if (args.changes.length > MAX_SHAPES) throw new Error(`${MAX_SHAPES} changements au plus par appel.`)
        const changes = args.changes.map(c => (c ?? {}) as Args)
        return editScene(api, d, ctx, draft => {
          for (const [i, c] of changes.entries()) {
            const ref = strArg(c, 'id')
            if (!ref) throw new Error(`Changement ${i + 1} : id attendu.`)
            let el = draft.get(ref)
            if (!el) throw new Error(`Élément introuvable : ${ref}. Voir drawing_read.`)
            // Le texte d'une forme : la geometrie est celle de la forme.
            const container = el.type === 'text' && typeof el.containerId === 'string' ? draft.get(el.containerId) : undefined
            const target = container ?? el
            const dx = numArg(c, 'dx') ?? 0, dy = numArg(c, 'dy') ?? 0
            const box = {
              ...(numArg(c, 'x') !== undefined || dx ? { x: (numArg(c, 'x') ?? Number(target.x)) + dx } : {}),
              ...(numArg(c, 'y') !== undefined || dy ? { y: (numArg(c, 'y') ?? Number(target.y)) + dy } : {}),
              ...(numArg(c, 'width') !== undefined ? { width: numArg(c, 'width')! } : {}),
              ...(numArg(c, 'height') !== undefined ? { height: numArg(c, 'height')! } : {}),
            }
            if (Object.keys(box).length) draft.move(target.id, box)
            const style = styleArg(c)
            if (c.color !== undefined || c.fill !== undefined || style) {
              draft.restyle(target.id, { ...(strArg(c, 'color') ? { color: strArg(c, 'color')! } : {}), ...(strArg(c, 'fill') ? { fill: strArg(c, 'fill')! } : {}), ...(style ? { style } : {}) })
            }
            if (typeof c.text === 'string') draft.setText(el.id, c.text)
            el = draft.get(target.id)
            for (const end of ['from', 'to'] as const) {
              if (typeof c[end] !== 'string') continue
              if (!el || (el.type !== 'arrow' && el.type !== 'line')) throw new Error(`${ref} n’est pas une flèche : ${end} ne s’applique pas.`)
              const ref2 = (c[end] as string).trim()
              if (ref2 && !draft.get(ref2)) throw new Error(`Élément introuvable : ${ref2}.`)
              draft.connect(el.id, end === 'from' ? 'start' : 'end', ref2 || null)
            }
          }
          const what = summary(draft)
          return { done: `Dessin modifié (${what}) :`, proposed: `Modification proposée (${what})`, note: what }
        })
      },
    },
    {
      spec: {
        name: 'drawing_delete', title: 'Effacer du dessin', action: 'edit', runtimes: [...RUNTIMES],
        description: 'Supprime des éléments d’un dessin Excalidraw, par identifiant (voir drawing_read). Le texte d’une forme part avec elle ; les flèches qui y étaient attachées restent, détachées.',
        inputSchema: {
          type: 'object',
          properties: { path: PATH, ids: { type: 'array', items: { type: 'string' }, description: 'Identifiants des éléments à supprimer.' } },
          required: ['path', 'ids'], additionalProperties: false,
        },
      },
      async run(args, ctx) {
        const d = drawingRef(api, args.path)
        const ids = Array.isArray(args.ids) ? args.ids.filter((x): x is string => typeof x === 'string' && !!x.trim()) : []
        if (!ids.length) throw new Error('Donnez les identifiants à supprimer (ids).')
        if (ids.length > MAX_SHAPES * 5) throw new Error(`${MAX_SHAPES * 5} éléments au plus par appel.`)
        return editScene(api, d, ctx, draft => {
          for (const id of ids) {
            if (!draft.get(id)) throw new Error(`Élément introuvable : ${id}. Voir drawing_read.`)
            draft.remove(id)
          }
          const n = draft.counts().removed
          return { done: `${n} élément(s) supprimé(s) de`, proposed: `Suppression de ${n} élément(s) proposée`, note: `${n} élément(s) supprimé(s)` }
        })
      },
    },
    {
      spec: {
        name: 'drawing_diagram', title: 'Dessiner un schéma', action: 'edit', runtimes: [...RUNTIMES],
        description: 'Dessine un schéma (organigramme, processus, carte d’idées) dans un dessin Excalidraw : des nœuds et des flèches, placés tout seuls en couches, de gauche à droite ou de haut en bas, à droite de ce qui est déjà dessiné. Un lien peut aussi viser un élément existant par son identifiant.',
        inputSchema: {
          type: 'object',
          properties: {
            path: PATH,
            nodes: {
              type: 'array', description: 'Les nœuds.',
              items: {
                type: 'object',
                properties: {
                  key: { type: 'string', description: 'Nom court et unique, repris par les liens.' },
                  text: { type: 'string', description: 'Texte affiché (la key par défaut).' },
                  shape: { type: 'string', enum: [...NODE_SHAPES], description: 'rectangle (défaut), ellipse, diamond (décision).' },
                  color: { type: 'string', description: COLOR }, fill: { type: 'string', description: FILL },
                },
              },
            },
            edges: {
              type: 'array', description: 'Les flèches entre nœuds (keys) ou vers des éléments existants (identifiants).',
              items: {
                type: 'object',
                properties: { from: { type: 'string' }, to: { type: 'string' }, text: { type: 'string', description: 'Étiquette sur la flèche.' }, color: { type: 'string', description: COLOR }, style: STYLE },
              },
            },
            direction: { type: 'string', enum: ['right', 'down'], description: 'Sens du schéma : right (défaut) ou down.' },
            x: { type: 'number', description: 'Coin haut-gauche du schéma (sinon à droite du dessin).' },
            y: { type: 'number' },
          },
          required: ['path', 'nodes'], additionalProperties: false,
        },
      },
      async run(args, ctx) {
        const d = drawingRef(api, args.path)
        const nodes = parseNodes(args.nodes)
        const edges = parseEdges(args.edges)
        const direction: DiagramDirection = args.direction === 'down' ? 'down' : 'right'
        return editScene(api, d, ctx, draft => {
          const keys = new Map<string, string>()
          const spot = freeSpot(draft.live())
          const origin = { x: numArg(args, 'x') ?? spot.x, y: numArg(args, 'y') ?? spot.y }
          const boxes = layoutDiagram(nodes, edges, direction, origin)
          for (const n of nodes) {
            const b = boxes.get(n.key)!
            const els = shapeElements({ type: n.shape ?? 'rectangle', ...b, text: n.text, ...(n.color ? { color: n.color } : {}), ...(n.fill ? { fill: n.fill } : {}) })
            draft.add(...els)
            keys.set(n.key, els[0]!.id)
          }
          const find = resolver(draft, keys)
          // Deux fleches entre les memes formes (aller et retour) : la seconde se courbe, sinon elles se recouvrent.
          const pairs = new Map<string, number>()
          for (const e of edges) {
            const from = draft.get(find(e.from))!
            const to = draft.get(find(e.to))!
            const start = edgePoint(from, centerOf(to))
            const end = edgePoint(to, centerOf(from))
            const [arrow, ...label] = shapeElements({
              type: 'arrow', x: start.x, y: start.y, width: end.x - start.x, height: end.y - start.y,
              ...(e.text ? { text: e.text } : {}), ...(e.color ? { color: e.color } : {}), ...(e.style ? { style: e.style } : {}),
            })
            draft.add(arrow!, ...label)
            draft.connect(arrow!.id, 'start', from.id)
            draft.connect(arrow!.id, 'end', to.id)
            const pair = [from.id, to.id].sort().join(' ')
            const before = pairs.get(pair) ?? 0
            pairs.set(pair, before + 1)
            if (before) draft.bend(arrow!.id, 55 * before)
          }
          const what = `${nodes.length} nœud(s), ${edges.length} flèche(s)`
          return { done: `Schéma dessiné (${what}) dans`, proposed: `Schéma proposé (${what})`, note: `schéma, ${what}`, extra: keysLine(keys) }
        })
      },
    },
    {
      spec: {
        name: 'drawing_create', title: 'Créer un dessin', action: 'create', runtimes: [...RUNTIMES],
        description: 'Crée un dessin Excalidraw (chemin .excalidraw), vide ou avec des formes (mêmes champs que drawing_add). Pour y poser un schéma ensuite : drawing_diagram. Un dessin se crée toujours ainsi, jamais par une note qui contiendrait son JSON.',
        inputSchema: {
          type: 'object',
          properties: { path: PATH, shapes: { type: 'array', description: 'Formes de départ (facultatif).', items: SHAPE_ITEM } },
          required: ['path'], additionalProperties: false,
        },
      },
      async run(args, ctx) {
        const raw = typeof args.path === 'string' ? args.path.trim().replace(/^\/+/, '') : ''
        if (!raw) throw new Error('Donnez le chemin du dessin.')
        const path = drawingPath(raw)
        const shapes = parseShapes(args.shapes, true)
        if (ctx.mode === 'propose') throw new Error('En mode proposition, un agent ne crée pas de dessin : il faut le droit de créer en direct.')
        if (api.vault.resolveDocumentId(path) || (api.vault.getFileTree?.() ?? []).some(f => f.path.toLowerCase() === path.toLowerCase())) {
          throw new Error(`Un document existe déjà : ${path}.`)
        }
        if (typeof api.vault.createFile !== 'function') throw new Error('Ce vault ne permet pas de créer de document.')
        const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
        if (folder) await api.vault.createFolder?.(folder)
        await api.vault.createFile(path)
        const id = await idAfterCreate(api, path)
        const d = { id, path }
        if (!shapes.length) return { text: `Dessin créé : ${path}.`, sources: [{ docId: id, path }] }
        const r = await editScene(api, d, ctx, draft => {
          const keys = addShapes(draft, shapes)
          return { done: `${shapes.length} forme(s) dans`, proposed: '', note: '', extra: keysLine(keys) }
        })
        return { ...r, text: `Dessin créé : ${r.text}` }
      },
    },
    {
      spec: {
        name: 'drawing_list', title: 'Lister les dessins', action: 'read', runtimes: [...RUNTIMES],
        description: 'Les dessins Excalidraw du vault (chemins .excalidraw), éventuellement d’un dossier.',
        inputSchema: { type: 'object', properties: { folder: { type: 'string', description: 'Dossier (facultatif).' } }, additionalProperties: false },
      },
      async run(args) {
        const folder = typeof args.folder === 'string' ? args.folder.trim().replace(/^\/+|\/+$/g, '') : ''
        const prefix = folder ? `${folder.toLowerCase()}/` : ''
        const all = (api.vault.getFileTree?.() ?? [])
          .filter(f => /\.excalidraw$/i.test(f.path) && !f.path.startsWith('.trash/') && f.path.toLowerCase().startsWith(prefix))
          .sort((a, b) => a.path.localeCompare(b.path))
        if (!all.length) return { text: folder ? `Aucun dessin dans ${folder}.` : 'Aucun dessin dans ce vault.' }
        const shown = all.slice(0, 200)
        return {
          text: `${all.length} dessin(s) :\n${shown.map(f => `- ${f.path}`).join('\n')}${all.length > shown.length ? `\n… et ${all.length - shown.length} autre(s).` : ''}`,
          sources: shown.slice(0, 20).map(f => ({ docId: f.docId, path: f.path })),
        }
      },
    },
  ]
}

/** L'id d'un document tout juste cree (l'arborescence suit un peu apres dans l'appli). */
async function idAfterCreate(api: PluginAPI, path: string, timeoutMs = 5000): Promise<string> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const id = api.vault.resolveDocumentId(path)
      ?? (api.vault.getFileTree?.() ?? []).find(f => f.path === path)?.docId
    if (id) return id
    if (Date.now() > until) throw new Error(`Dessin introuvable après sa création : ${path}.`)
    await new Promise(res => setTimeout(res, 50))
  }
}
