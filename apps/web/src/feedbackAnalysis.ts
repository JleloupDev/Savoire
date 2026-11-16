// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Analyse des retours par l'IA (page Admin, onglet Retours). Elle tourne dans
// le navigateur de l'administrateur, avec sa connexion IA a lui (Parametres →
// IA) : le serveur ne voit ni la cle ni la reponse.
//
// Aujourd'hui : un seul appel (SimpleFeedbackAnalyzer). Les messages et leur
// contexte partent, pas les captures. Demain : un agent (autre
// FeedbackAnalyzer) qui pourra regarder les captures, relire un retour,
// regrouper en plusieurs passes. L'ecran ne connait que FeedbackAnalyzer.
import type { AIChatRequest, AIChatResponse } from '@savoire/plugin-api'
import type { FeedbackReport } from './feedback'

export interface FeedbackTheme {
  title: string
  description: string
  /** high | medium | low */
  priority: 'high' | 'medium' | 'low'
  /** Retours qui en parlent (leurs ids). */
  reportIds: string[]
}

export interface FeedbackAnalysis {
  summary: string
  themes: FeedbackTheme[]
  suggestions: string[]
  /** Reponse brute, quand elle n'a pas pu etre lue en JSON. */
  raw?: string
  analyzedCount: number
  model: string
  connection: string
}

export interface FeedbackAnalyzer {
  readonly label: string
  analyze(reports: FeedbackReport[], options?: { signal?: AbortSignal }): Promise<FeedbackAnalysis>
}

export type ChatFn = (request: AIChatRequest) => Promise<AIChatResponse>

/** Taille maximale des retours envoyes en une fois (caracteres). Les plus recents d'abord. */
const MAX_PROMPT_CHARS = 60_000

const SYSTEM_PROMPT = `Tu analyses les retours de testeurs d'une application de prise de notes (Savoire).
Chaque retour a un id, une date, une personne, un message et le contexte de l'écran.
Regroupe les retours par thème, du plus important au moins important.
Un thème est important s'il revient souvent, s'il bloque le travail ou s'il touche beaucoup de monde.
Réponds en français, phrases courtes, en JSON strict :
{"summary": "3 à 5 phrases", "themes": [{"title": "...", "description": "...", "priority": "high|medium|low", "reportIds": ["..."]}], "suggestions": ["action concrète", "..."]}
N'invente rien qui ne soit pas dans les retours.`

/** Un retour, en quelques lignes pour l'IA. */
export function describeReport(r: FeedbackReport): string {
  let ctx: Record<string, unknown> = {}
  try { ctx = JSON.parse(r.context) as Record<string, unknown> } catch { /* contexte illisible : sans */ }
  const where = [ctx.platform, ctx.viewport, ctx.title].filter(Boolean).join(', ')
  const errors = Array.isArray(ctx.recentErrors) && ctx.recentErrors.length ? `\nErreurs récentes : ${ctx.recentErrors.join(' | ')}` : ''
  return `[${r.id}] ${r.createdAt.slice(0, 10)} — ${r.userName ?? r.userId}${where ? ` (${where})` : ''}${r.hasScreenshot ? ' [capture]' : ''}\n${r.message}${errors}`
}

/** Les retours qui tiennent dans la limite, les plus recents d'abord. */
export function buildPrompt(reports: FeedbackReport[], maxChars = MAX_PROMPT_CHARS): { text: string; count: number } {
  const sorted = [...reports].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const parts: string[] = []
  let size = 0
  for (const r of sorted) {
    const part = describeReport(r)
    if (size + part.length > maxChars && parts.length > 0) break
    parts.push(part)
    size += part.length + 2
  }
  return { text: parts.join('\n\n'), count: parts.length }
}

/** Lit la reponse de l'IA ; tolere un bloc ```json autour. */
export function parseAnalysis(text: string, knownIds: Set<string>): Pick<FeedbackAnalysis, 'summary' | 'themes' | 'suggestions' | 'raw'> {
  const body = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let data: unknown
  try { data = JSON.parse(body) } catch { return { summary: '', themes: [], suggestions: [], raw: text } }
  const o = (data ?? {}) as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const themes = (Array.isArray(o.themes) ? o.themes : []).map((t): FeedbackTheme => {
    const th = (t ?? {}) as Record<string, unknown>
    const priority = th.priority === 'high' || th.priority === 'low' ? th.priority : 'medium'
    const ids = Array.isArray(th.reportIds) ? th.reportIds.map(String).filter(id => knownIds.has(id)) : []
    return { title: str(th.title) || 'Sans titre', description: str(th.description), priority, reportIds: ids }
  })
  const suggestions = (Array.isArray(o.suggestions) ? o.suggestions : []).map(str).filter(Boolean)
  return { summary: str(o.summary), themes, suggestions }
}

/** Un appel, une reponse : resume, themes, suggestions. */
export class SimpleFeedbackAnalyzer implements FeedbackAnalyzer {
  readonly label = 'Analyse simple (un appel)'
  constructor(private readonly chat: ChatFn) {}

  async analyze(reports: FeedbackReport[], options: { signal?: AbortSignal } = {}): Promise<FeedbackAnalysis> {
    if (reports.length === 0) throw new Error('Aucun retour à analyser.')
    const { text, count } = buildPrompt(reports)
    const res = await this.chat({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `${count} retours :\n\n${text}` },
      ],
      temperature: 0.2,
      json: true,
      signal: options.signal,
    })
    const ids = new Set(reports.map(r => r.id))
    return { ...parseAnalysis(res.text, ids), analyzedCount: count, model: res.model, connection: res.connection }
  }
}
