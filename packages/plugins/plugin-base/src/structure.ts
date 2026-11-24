// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Structure d'une base au-dela des colonnes : actions (des boutons et des
// automatisations), automatisations (« quand une page est ajoutee » ou
// « quand une propriete change », alors poser des valeurs), modeles de ligne
// (notes du dossier Modeles/<Base>/, l'un par defaut, certains repetes
// chaque jour, semaine ou mois).
//
// Les automatisations s'executent chez la personne qui fait la modification,
// depuis la base (tableau, kanban, apercu...) : une seule fois, sans serveur.
// Une note modifiee ailleurs (son editeur) ne les declenche pas.
import { TEMPLATE_FOLDERS } from '@savoire/plugin-api'
import type { PropertyValue } from '@savoire/plugin-api'

// ── Actions ──────────────────────────────────────────────────────────────

export type ActionDef =
  /** Pose une valeur. */
  | { kind: 'set'; key: string; value: PropertyValue }
  /** Pose la date et l'heure du moment. */
  | { kind: 'now'; key: string }
  /** Pose la personne qui agit. */
  | { kind: 'me'; key: string }
  /** Vide la propriete. */
  | { kind: 'clear'; key: string }

export const ACTION_KINDS: { kind: ActionDef['kind']; label: string }[] = [
  { kind: 'set', label: 'Mettre la valeur' },
  { kind: 'now', label: 'Mettre la date du moment' },
  { kind: 'me', label: 'M’attribuer' },
  { kind: 'clear', label: 'Vider' },
]

function readValue(v: unknown): PropertyValue {
  if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  if (Array.isArray(v)) return v.map(String)
  return null
}

export function readActions(raw: unknown): ActionDef[] {
  if (!Array.isArray(raw)) return []
  const out: ActionDef[] = []
  for (const a of raw.slice(0, 20)) {
    const o = a as Record<string, unknown> | null
    if (!o || typeof o.key !== 'string' || !o.key) continue
    switch (o.kind) {
      case 'set': out.push({ kind: 'set', key: o.key, value: readValue(o.value) }); break
      case 'now': case 'me': case 'clear': out.push({ kind: o.kind, key: o.key }); break
    }
  }
  return out
}

export interface ActionContext {
  /** Date-heure locale 'YYYY-MM-DDTHH:mm'. */
  now: string
  /** Id de la personne qui agit. */
  me?: string
  /** Une personne peut-elle etre une liste pour cette propriete ? */
  multiple?(key: string): boolean
}

/** Les valeurs posees par des actions. */
export function actionValues(actions: readonly ActionDef[], ctx: ActionContext): Record<string, PropertyValue> {
  const out: Record<string, PropertyValue> = {}
  for (const a of actions) {
    switch (a.kind) {
      case 'set': out[a.key] = a.value; break
      case 'now': out[a.key] = ctx.now; break
      case 'me': if (ctx.me) out[a.key] = ctx.multiple?.(a.key) ? [ctx.me] : ctx.me; break
      case 'clear': out[a.key] = null; break
    }
  }
  return out
}

/** Phrase d'une action, pour les listes. */
export function actionText(a: ActionDef, label: (key: string) => string): string {
  switch (a.kind) {
    case 'set': return `${label(a.key)} ← ${Array.isArray(a.value) ? a.value.join(', ') : String(a.value ?? '')}`
    case 'now': return `${label(a.key)} ← maintenant`
    case 'me': return `${label(a.key)} ← moi`
    case 'clear': return `${label(a.key)} ← vide`
  }
}

// ── Boutons ──────────────────────────────────────────────────────────────

export interface ButtonDef {
  label: string
  then: ActionDef[]
}

export function readButton(raw: unknown): ButtonDef | undefined {
  const o = raw as Record<string, unknown> | null
  if (!o || typeof o !== 'object') return undefined
  const then = readActions(o.then)
  if (!then.length) return undefined
  return { label: typeof o.label === 'string' && o.label ? o.label.slice(0, 60) : 'Bouton', then }
}

// ── Automatisations ──────────────────────────────────────────────────────

export type Trigger =
  | { kind: 'added' }
  /** Une propriete change ; avec `value`, seulement quand elle prend cette valeur. */
  | { kind: 'changed'; key: string; value?: PropertyValue }

export interface AutomationDef {
  id: string
  name: string
  enabled: boolean
  when: Trigger
  then: ActionDef[]
}

export function readAutomations(raw: unknown): AutomationDef[] {
  if (!Array.isArray(raw)) return []
  const out: AutomationDef[] = []
  for (const x of raw.slice(0, 50)) {
    const o = x as Record<string, unknown> | null
    if (!o || typeof o.id !== 'string') continue
    const w = o.when as Record<string, unknown> | null
    let when: Trigger | null = null
    if (w?.kind === 'added') when = { kind: 'added' }
    else if (w?.kind === 'changed' && typeof w.key === 'string' && w.key) {
      when = { kind: 'changed', key: w.key, ...(w.value !== undefined && w.value !== '' ? { value: readValue(w.value) } : {}) }
    }
    const then = readActions(o.then)
    if (!when || !then.length) continue
    out.push({ id: o.id, name: typeof o.name === 'string' ? o.name : '', enabled: o.enabled !== false, when, then })
  }
  return out
}

const same = (a: PropertyValue | undefined, b: PropertyValue | undefined) => {
  const norm = (v: PropertyValue | undefined) => Array.isArray(v) ? v.map(String) : v === undefined ? null : v
  const x = norm(a), y = norm(b)
  if (Array.isArray(x) && !Array.isArray(y)) return x.includes(String(y))
  return JSON.stringify(x) === JSON.stringify(y)
}

/** Les automatisations declenchees par un changement de `key` vers `value`. */
export function triggered(list: readonly AutomationDef[], key: string, value: PropertyValue): AutomationDef[] {
  return list.filter(a => a.enabled && a.when.kind === 'changed' && a.when.key === key
    && (a.when.value === undefined || same(value, a.when.value)))
}

/** Les automatisations « quand une page est ajoutee ». */
export function onAdded(list: readonly AutomationDef[]): AutomationDef[] {
  return list.filter(a => a.enabled && a.when.kind === 'added')
}

// ── Modeles ──────────────────────────────────────────────────────────────

export type Repeat = 'daily' | 'weekly' | 'monthly'

export const REPEATS: { value: Repeat | ''; label: string }[] = [
  { value: '', label: 'Jamais' },
  { value: 'daily', label: 'Chaque jour' },
  { value: 'weekly', label: 'Chaque semaine' },
  { value: 'monthly', label: 'Chaque mois' },
]

export interface TemplateSettings {
  /** Chemin du modele par defaut ('' : aucun). */
  defaultTemplate: string
  /** Modeles repetes : chemin -> frequence et derniere periode faite. */
  repeats: Record<string, { every: Repeat; last: string }>
}

export function readTemplateSettings(raw: unknown): TemplateSettings {
  const o = raw as Record<string, unknown> | null
  const repeats: TemplateSettings['repeats'] = {}
  const r = o?.repeats as Record<string, { every?: unknown; last?: unknown }> | undefined
  if (r && typeof r === 'object') {
    for (const [path, v] of Object.entries(r)) {
      if (v && (v.every === 'daily' || v.every === 'weekly' || v.every === 'monthly')) repeats[path] = { every: v.every, last: typeof v.last === 'string' ? v.last : '' }
    }
  }
  return { defaultTemplate: typeof o?.defaultTemplate === 'string' ? o.defaultTemplate : '', repeats }
}

/** Dossier des modeles d'une base : Modeles/<nom de la base>/. */
export function templateFolder(baseName: string): string {
  return `${TEMPLATE_FOLDERS[0]}${baseName}`
}

const pad = (n: number) => String(n).padStart(2, '0')

/** La periode d'une date pour une frequence : 2026-11-24, 2026-S48, 2026-11. */
export function periodOf(every: Repeat, d: Date): string {
  if (every === 'daily') return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  if (every === 'monthly') return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7))
  const w = Math.ceil(((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7)
  return `${t.getUTCFullYear()}-S${pad(w)}`
}

/** Les modeles a repeter maintenant (leur periode n'est pas encore faite). */
export function dueTemplates(settings: TemplateSettings, now: Date): { path: string; period: string }[] {
  const out: { path: string; period: string }[] = []
  for (const [path, r] of Object.entries(settings.repeats)) {
    const period = periodOf(r.every, now)
    if (r.last !== period) out.push({ path, period })
  }
  return out
}
