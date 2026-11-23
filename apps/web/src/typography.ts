// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Mise en page du texte, comme les styles de Word : l'interligne et
// l'espace avant et apres les titres. Le theme les donne (variables --plume-* de
// app.css, sur la racine) ; on peut les changer ici, sur ce poste. Les
// valeurs choisies se posent sur <body> : celles du theme restent lisibles
// sur la racine, et un autre theme garde ses propres valeurs pour tout ce
// qu'on n'a pas change.

import { useSyncExternalStore } from 'react'
// Meme nom que LAYOUT_CHANGE_EVENT de @savoire/editor-core (sans charger l'editeur ici).
const LAYOUT_CHANGE_EVENT = 'plume:layout-change'

const KEY = 'savoire-typography'

/** Les niveaux reglables : titres 1, 2, 3, et 4 a 6 ensemble. */
export const HEADING_STEPS = [1, 2, 3, 4] as const
export type HeadingStep = (typeof HEADING_STEPS)[number]

export interface Typography {
  /** Interligne du texte (1,65 = une ligne et deux tiers). */
  lineHeight?: number
  /** Espace avant un titre, en points. */
  before?: Partial<Record<HeadingStep, number>>
  /** Espace apres un titre, en points. */
  after?: Partial<Record<HeadingStep, number>>
}

export type SpaceSide = 'before' | 'after'
export const SPACE_SIDES: readonly SpaceSide[] = ['before', 'after']

let value: Typography = load()
const listeners = new Set<() => void>()

function load(): Typography {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? clean(JSON.parse(raw) as Typography) : {}
  } catch {
    return {}
  }
}

const num = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : undefined

/** Seulement des valeurs sensees ; ce qui manque reste celui du theme. */
export function clean(t: Typography): Typography {
  const out: Typography = {}
  const lh = num(t?.lineHeight, 1, 3)
  if (lh !== undefined) out.lineHeight = lh
  for (const side of SPACE_SIDES) {
    const space: Partial<Record<HeadingStep, number>> = {}
    for (const step of HEADING_STEPS) {
      const v = num(t?.[side]?.[step], 0, 72)
      if (v !== undefined) space[step] = v
    }
    if (Object.keys(space).length) out[side] = space
  }
  return out
}

/** Les variables CSS d'un reglage (null : celle du theme). */
export function typographyVariables(t: Typography): Record<string, string | null> {
  const vars: Record<string, string | null> = { '--plume-line-height': t.lineHeight !== undefined ? String(t.lineHeight) : null }
  for (const side of SPACE_SIDES) {
    for (const step of HEADING_STEPS) {
      const pt = t[side]?.[step]
      const levels = step === 4 ? [4, 5, 6] : [step]
      for (const level of levels) vars[`--plume-h${level}-${side}`] = pt !== undefined ? `${pt}pt` : null
    }
  }
  return vars
}

/** Pose les valeurs choisies (au demarrage, puis a chaque changement). */
export function applyTypography(): void {
  if (typeof document === 'undefined' || !document.body) return
  for (const [name, v] of Object.entries(typographyVariables(value))) {
    if (v === null) document.body.style.removeProperty(name)
    else document.body.style.setProperty(name, v)
  }
  layoutChanged()
}

/** Les editeurs remesurent leurs lignes (theme ou mise en page changes). */
export function layoutChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(LAYOUT_CHANGE_EVENT))
}

export function typography(): Typography {
  return value
}

export function setTypography(next: Typography): void {
  value = clean(next)
  try {
    if (Object.keys(value).length) localStorage.setItem(KEY, JSON.stringify(value))
    else localStorage.removeItem(KEY)
  } catch { /* navigation privee */ }
  applyTypography()
  for (const cb of [...listeners]) cb()
}

export function useTypography(): Typography {
  return useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb) } }, typography)
}

/** Les valeurs du theme en cours (sur la racine), pour les montrer en filigrane. */
export function themeTypography(): { lineHeight: number; before: Record<HeadingStep, number>; after: Record<HeadingStep, number> } {
  const css = typeof document === 'undefined' ? null : getComputedStyle(document.documentElement)
  const read = (name: string, fallback: number) => {
    const v = parseFloat(css?.getPropertyValue(name) ?? '')
    return Number.isFinite(v) ? v : fallback
  }
  return {
    lineHeight: read('--plume-line-height', 1.65),
    before: { 1: read('--plume-h1-before', 12), 2: read('--plume-h2-before', 10), 3: read('--plume-h3-before', 8), 4: read('--plume-h4-before', 6) },
    after: { 1: read('--plume-h1-after', 4), 2: read('--plume-h2-after', 3), 3: read('--plume-h3-after', 2), 4: read('--plume-h4-after', 0) },
  }
}
