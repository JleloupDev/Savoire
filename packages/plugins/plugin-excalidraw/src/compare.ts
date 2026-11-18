// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Comparer deux etats d'un dessin (Revision) : la scene apres une
// proposition, les elements qui changent, et une scene coloriee des
// differences (ajoute en vert, retire en rouge, modifie en orange, deplace en
// bleu ; le reste estompe). Fonctions pures, sur le JSON d'une scene.
import type { DiffItem } from '@savoire/plugin-api'
import type { SceneElement, ScenePatch } from './binding'

interface Scene { elements: SceneElement[]; appState?: Record<string, unknown>; files?: Record<string, unknown> }

const BG = { viewBackgroundColor: '#1e1e2e' }

export function parseScene(raw: string): Scene {
  try {
    const s = JSON.parse(raw || '{}') as Partial<Scene>
    return { elements: Array.isArray(s.elements) ? s.elements : [], appState: s.appState ?? BG, files: s.files ?? {} }
  } catch {
    return { elements: [], appState: BG, files: {} }
  }
}

export const sceneJson = (elements: SceneElement[]): string =>
  JSON.stringify({ elements: elements.filter(e => !e.isDeleted), appState: BG, files: {} })

/** La scene une fois la proposition appliquee. */
export function applyPatchToElements(elements: SceneElement[], patch: ScenePatch): SceneElement[] {
  const byId = new Map(elements.map(e => [e.id, e]))
  for (const el of patch.elements) byId.set(el.id, el)
  return [...byId.values()]
}

const live = (s: Scene) => new Map(s.elements.filter(e => !e.isDeleted).map(e => [e.id, e]))

/** Ce qui ne compte pas pour dire qu'un element a change. */
const VOLATILE = new Set(['version', 'versionNonce', 'updated', 'seed', 'index'])
const POSITION = new Set(['x', 'y'])

function changes(a: SceneElement, b: SceneElement): 'same' | 'moved' | 'modified' {
  let moved = false
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) {
    if (VOLATILE.has(k)) continue
    if (JSON.stringify(a[k]) === JSON.stringify(b[k])) continue
    if (POSITION.has(k)) moved = true
    else return 'modified'
  }
  return moved ? 'moved' : 'same'
}

const LABELS: Record<string, string> = {
  rectangle: 'Rectangle', ellipse: 'Ellipse', diamond: 'Losange', arrow: 'Flèche', line: 'Ligne',
  freedraw: 'Trait libre', text: 'Texte', image: 'Image', frame: 'Cadre',
}

function labelOf(e: SceneElement): string {
  const kind = LABELS[String(e.type)] ?? 'Élément'
  const text = typeof e.text === 'string' && e.text.trim() ? ` « ${e.text.trim().slice(0, 30)} »` : ''
  return kind + text
}

/** Les elements qui changent d'une scene a l'autre. */
export function diffScenes(beforeRaw: string, afterRaw: string): DiffItem[] {
  const before = live(parseScene(beforeRaw))
  const after = live(parseScene(afterRaw))
  const out: DiffItem[] = []
  for (const [id, b] of after) {
    const a = before.get(id)
    if (!a) { out.push({ id, change: 'added', label: labelOf(b) }); continue }
    const c = changes(a, b)
    if (c !== 'same') out.push({ id, change: c, label: labelOf(b) })
  }
  for (const [id, a] of before) if (!after.has(id)) out.push({ id, change: 'removed', label: labelOf(a) })
  return out
}

const COLORS: Record<DiffItem['change'], string> = { added: '#22c55e', removed: '#ef4444', modified: '#f59e0b', moved: '#3b82f6' }

/** Une scene des differences : l'etat propose, plus les elements retires, colories. */
export function diffSceneJson(beforeRaw: string, afterRaw: string): string {
  const diffs = new Map(diffScenes(beforeRaw, afterRaw).map(d => [d.id, d]))
  const before = live(parseScene(beforeRaw))
  const after = live(parseScene(afterRaw))
  const els: SceneElement[] = []
  for (const [id, e] of after) {
    const d = diffs.get(id)
    els.push(d ? { ...e, strokeColor: COLORS[d.change], strokeWidth: Math.max(Number(e.strokeWidth) || 1, 3) } : { ...e, opacity: 25 })
  }
  for (const [id, e] of before) {
    if (!after.has(id)) els.push({ ...e, strokeColor: COLORS.removed, strokeStyle: 'dashed', opacity: 70 })
  }
  return sceneJson(els)
}
