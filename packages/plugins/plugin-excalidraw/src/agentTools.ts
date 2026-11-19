// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Outils d'agent d'Excalidraw (ADR-033) : lire un dessin (ses formes et ses
// textes), y ajouter des formes. L'ajout est fait, ou propose dans la
// Revision (type « excalidraw.scene », le meme que le mode suggestion).
// Dans l'appli seulement : la scene est un arbre partage (openTree).
import { type PluginAPI, type PluginTool, type ToolParamSchema } from '@savoire/plugin-api'
import { SceneBinding, applyScenePatch, type SceneElement, type ScenePatch } from './binding'

/** Type de proposition d'un dessin (Revision) : des elements changes. */
export const SCENE_PROPOSAL = 'excalidraw.scene'

const SHAPES = ['rectangle', 'ellipse', 'diamond', 'text', 'arrow', 'line'] as const
type ShapeType = typeof SHAPES[number]

export interface ShapeInput {
  type: ShapeType
  x: number
  y: number
  width?: number
  height?: number
  text?: string
  color?: string
}

const FONT_SIZE = 20
const LINE_HEIGHT = 1.25

const randomInt = (): number => Math.floor(Math.random() * 2 ** 31)
const newId = (): string => Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12)

function base(type: string, x: number, y: number, width: number, height: number, color: string): SceneElement {
  return {
    id: newId(), type, x, y, width, height, angle: 0,
    strokeColor: color, backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid',
    roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: type === 'rectangle' ? { type: 3 } : null,
    seed: randomInt(), version: 1, versionNonce: randomInt(), isDeleted: false, boundElements: null,
    updated: Date.now(), link: null, locked: false,
  }
}

function textElement(text: string, x: number, y: number, color: string, containerId: string | null): SceneElement {
  const lines = text.split('\n')
  const width = Math.max(...lines.map(l => l.length)) * FONT_SIZE * 0.55
  const height = lines.length * FONT_SIZE * LINE_HEIGHT
  return {
    ...base('text', containerId ? x - width / 2 : x, containerId ? y - height / 2 : y, width, height, color),
    text, originalText: text, fontSize: FONT_SIZE, fontFamily: 1, lineHeight: LINE_HEIGHT, baseline: Math.round(FONT_SIZE * 0.9),
    textAlign: containerId ? 'center' : 'left', verticalAlign: containerId ? 'middle' : 'top', containerId, autoResize: true,
  }
}

/** Les elements Excalidraw d'une forme (une forme et son texte, s'il y en a). */
export function shapeElements(s: ShapeInput): SceneElement[] {
  const color = s.color && /^#[0-9a-f]{3,8}$/i.test(s.color) ? s.color : '#1e1e1e'
  const text = s.text?.trim() ?? ''
  if (s.type === 'text') return [textElement(text || ' ', s.x, s.y, color, null)]
  const width = s.width ?? (s.type === 'arrow' || s.type === 'line' ? 200 : 160)
  const height = s.height ?? (s.type === 'arrow' || s.type === 'line' ? 0 : 80)
  if (s.type === 'arrow' || s.type === 'line') {
    return [{
      ...base(s.type, s.x, s.y, Math.abs(width), Math.abs(height), color),
      points: [[0, 0], [width, height]], lastCommittedPoint: null, startBinding: null, endBinding: null,
      startArrowhead: null, endArrowhead: s.type === 'arrow' ? 'arrow' : null,
    }]
  }
  const shape = base(s.type, s.x, s.y, width, height, color)
  if (!text) return [shape]
  const label = textElement(text, s.x + width / 2, s.y + height / 2, color, shape.id)
  return [{ ...shape, boundElements: [{ type: 'text', id: label.id }] }, label]
}

function parseShapes(v: unknown): ShapeInput[] {
  if (!Array.isArray(v) || !v.length) throw new Error('Donnez au moins une forme (shapes).')
  if (v.length > 100) throw new Error('100 formes au plus par appel.')
  return v.map((raw, i) => {
    const s = (raw ?? {}) as Record<string, unknown>
    const type = String(s.type ?? '') as ShapeType
    if (!SHAPES.includes(type)) throw new Error(`Forme ${i + 1} : type parmi ${SHAPES.join(', ')}.`)
    const num = (k: string): number | undefined => (typeof s[k] === 'number' && Number.isFinite(s[k]) ? s[k] as number : undefined)
    const x = num('x'); const y = num('y')
    if (x === undefined || y === undefined) throw new Error(`Forme ${i + 1} : x et y attendus.`)
    const w = num('width'); const h = num('height')
    return { type, x, y, ...(w !== undefined ? { width: w } : {}), ...(h !== undefined ? { height: h } : {}), ...(typeof s.text === 'string' ? { text: s.text } : {}), ...(typeof s.color === 'string' ? { color: s.color } : {}) }
  })
}

/** Une ligne par element visible : forme, position, taille, texte. */
export function describeScene(elements: readonly SceneElement[]): string {
  const live = elements.filter(e => !e.isDeleted)
  if (!live.length) return 'Dessin vide.'
  const labels = new Map<string, string>()
  for (const e of live) if (e.type === 'text' && typeof e.containerId === 'string') labels.set(e.containerId, String(e.text ?? ''))
  const r = (n: unknown): number => Math.round(Number(n) || 0)
  const lines = live.filter(e => !(e.type === 'text' && typeof e.containerId === 'string' && labels.has(e.containerId))).map(e => {
    const text = e.type === 'text' ? String(e.text ?? '') : labels.get(e.id)
    return `- ${String(e.type)} ${e.id} à (${r(e.x)}, ${r(e.y)}), ${r(e.width)}×${r(e.height)}${text ? ` : « ${text.replace(/\n/g, ' ')} »` : ''}`
  })
  return `${lines.length} élément(s) :\n${lines.join('\n')}`
}

function drawingRef(api: PluginAPI, path: unknown): { id: string; path: string } {
  const raw = typeof path === 'string' ? path.trim() : ''
  if (!raw) throw new Error('Donnez le dessin (chemin .excalidraw).')
  const wanted = /\.excalidraw$/i.test(raw) ? raw : `${raw}.excalidraw`
  const hit = (api.vault.getFileTree?.() ?? []).find(f => f.docId === raw || f.path.toLowerCase() === wanted.toLowerCase())
  if (hit) return { id: hit.docId, path: hit.path }
  const id = api.vault.resolveDocumentId(wanted)
  if (!id) throw new Error(`Dessin introuvable : ${wanted}.`)
  return { id, path: wanted }
}

async function withTree<T>(api: PluginAPI, docId: string, fn: (b: SceneBinding, tree: Parameters<typeof applyScenePatch>[0]) => T): Promise<T> {
  if (!api.vault.openTree) throw new Error('Dessin indisponible sans synchronisation du vault.')
  const tree = await api.vault.openTree(docId)
  try {
    const b = new SceneBinding({ tree, getElements: () => null, applyElements: () => {}, hasFile: () => false, addFiles: () => {} })
    return fn(b, tree)
  } finally {
    api.vault.closeTree?.(docId)
  }
}

export function excalidrawAgentTools(api: PluginAPI): PluginTool[] {
  const path: ToolParamSchema = { type: 'string', description: 'Dessin (chemin .excalidraw).' }
  return [
    {
      spec: {
        name: 'drawing_read', title: 'Lire un dessin', action: 'read',
        description: 'Les formes et les textes d’un dessin Excalidraw : type, identifiant, position, taille, texte.',
        inputSchema: { type: 'object', properties: { path }, required: ['path'], additionalProperties: false },
      },
      async run(args) {
        const d = drawingRef(api, args.path)
        const elements = await withTree(api, d.id, b => b.readElements())
        return { text: `# ${d.path}\n\n${describeScene(elements)}`, sources: [{ docId: d.id, path: d.path }] }
      },
    },
    {
      spec: {
        name: 'drawing_add', title: 'Ajouter au dessin', action: 'edit',
        description: 'Ajoute des formes à un dessin Excalidraw. Chaque forme : type (rectangle, ellipse, diamond, text, arrow, line), x, y, width et height (une flèche va de (x, y) à (x+width, y+height)), text (étiquette ou texte), color (#rrggbb).',
        inputSchema: {
          type: 'object',
          properties: {
            path,
            shapes: {
              type: 'array', description: 'Les formes à ajouter.',
              items: {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: [...SHAPES] }, x: { type: 'number' }, y: { type: 'number' },
                  width: { type: 'number' }, height: { type: 'number' }, text: { type: 'string' }, color: { type: 'string' },
                },
              },
            },
          },
          required: ['path', 'shapes'], additionalProperties: false,
        },
      },
      async run(args, ctx) {
        const d = drawingRef(api, args.path)
        const elements = parseShapes(args.shapes).flatMap(shapeElements)
        const patch: ScenePatch = { elements, base: Object.fromEntries(elements.map(e => [e.id, null])) }
        const n = elements.filter(e => !(e.type === 'text' && e.containerId)).length
        if (ctx.mode === 'propose') {
          if (!api.review) throw new Error('Révision indisponible.')
          await api.review.propose(d.id, SCENE_PROPOSAL, patch, `${ctx.actor.agentName} : ${n} forme(s)`)
          return { text: `${n} forme(s) proposée(s) dans ${d.path} (Révision).`, sources: [{ docId: d.id, path: d.path }] }
        }
        const { conflicts } = await withTree(api, d.id, (_b, tree) => applyScenePatch(tree, patch))
        if (conflicts.length) throw new Error('Le dessin a changé : réessayez.')
        return { text: `${n} forme(s) ajoutée(s) à ${d.path}.`, sources: [{ docId: d.id, path: d.path }] }
      },
    },
  ]
}
