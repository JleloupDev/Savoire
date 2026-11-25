// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Les outils du contexte de l'editeur, dans l'appli : get_context (ou
// travaille la personne, ses surlignages) et list_pins (ses epingles).
// L'appli connait son propre editeur : pas d'aller-retour par le serveur.
// Pour les IA externes, le serveur sert les memes outils (api/open.rs).
import type { ToolResult } from '@savoire/plugin-api'
import type { CoreTool, CoreToolContext } from './coreTools'
import { CONTEXT_STALE_SECONDS, type AiMark } from './editorContext'
import { HostError } from './host'
import { pathInScope } from './policy'
import { TYPING_GUARD_MS } from './typingGuard'

const quoted = (s: string): string => `« ${s.replace(/\n/g, ' ⏎ ')} »`

function visible(ctx: CoreToolContext, marks: AiMark[]): AiMark[] {
  return marks.filter(m => pathInScope(ctx.scope, m.path))
}

const getContext: CoreTool = {
  spec: {
    name: 'get_context', title: 'Où travaille la personne', action: 'read', runtimes: ['app'],
    description: 'Ce que la personne a sous les yeux dans Savoire : la note ouverte, le texte qu’elle a sélectionné (ou l’endroit du curseur), '
      + 'la section, et les passages qu’elle a surlignés pour vous. Appelez-le de vous-même, avant de répondre ou d’agir, dès qu’elle dit '
      + '« ici », « ce passage », « ça », « cette phrase », « la sélection », ou qu’elle demande de reformuler, corriger ou compléter sans dire '
      + 'de quelle note elle parle. La sélection éclaire la demande ; ce n’est pas une vérité absolue : si elle ne colle pas, posez la question.',
    inputSchema: {
      type: 'object',
      properties: { seconds_ago: { type: 'integer', description: 'Lire où était la personne il y a tant de secondes : le moment où elle a parlé (ex. 20). 0 ou absent : maintenant.' } },
      required: [],
      additionalProperties: false,
    },
  },
  async run(args, ctx): Promise<ToolResult> {
    if (!ctx.host.editorContext) throw new HostError('Le contexte de l’éditeur est indisponible ici.', 'unavailable')
    const raw = args.seconds_ago
    const secondsAgo = typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.min(3600, Math.floor(raw))) : 0
    const found = await ctx.host.editorContext({ secondsAgo })
    const highlights = visible(ctx, await ctx.host.aiMarks?.('highlight') ?? [])
    const lines: string[] = []
    let data: Record<string, unknown> = {}
    if (!found) {
      lines.push('Aucun contexte : la personne n’a pas de note ouverte. Demandez-lui de quelle note elle parle.')
    } else if (!pathInScope(ctx.scope, found.entry.path)) {
      lines.push('Aucun contexte accessible : la personne travaille dans une note hors de la portée de cet agent. Demandez-lui de quelle note elle parle.')
    } else {
      const { entry: e, ageSeconds } = found
      const stale = ageSeconds > CONTEXT_STALE_SECONDS
      const hint = stale
        ? 'Ce contexte date de plus de 2 minutes : demandez à la personne de confirmer que c’est bien ce passage avant d’agir.'
        : 'Contexte récent. La sélection éclaire la demande, sans être une vérité absolue : en cas de doute, demandez.'
      lines.push(`Contexte de l’éditeur, il y a ${ageSeconds} s.`, `Note : ${e.path} (id : ${e.docId})`)
      if (e.headingPath.length) lines.push(`Section : ${e.headingPath.join(' > ')}`)
      if (e.selection === '') lines.push(`Pas de sélection : le curseur est entre ${quoted(e.before)} et ${quoted(e.after)}.`)
      else {
        lines.push(`Sélection (${e.selection.length} caractères${e.selectionTruncated ? ', tronquée' : ''}) :`, e.selection,
          `Juste avant : ${quoted(e.before)}`, `Juste après : ${quoted(e.after)}`)
      }
      lines.push(`Ancre : ${JSON.stringify(e.anchor)}`, hint)
      // Elle tape dans cette note : l'IA le sait avant d'ecrire.
      const spot = await ctx.host.typing?.(e.docId).catch(() => null)
      const typing = !!spot && spot.ageMs < TYPING_GUARD_MS
      if (typing) lines.push('La personne écrit dans cette note en ce moment : n’écrivez pas dans son paragraphe. Attendez, ou proposez (propose: true).')
      data = { ...e, noteId: e.docId, ageSeconds, stale, hint, isCursor: e.selection === '', ...(typing ? { typing } : {}) }
    }
    if (highlights.length) {
      lines.push('', `Passages surlignés pour l’IA (${highlights.length}) :`)
      for (const h of highlights) lines.push(`- ${h.path} (id : ${h.docId}) : ${quoted(h.anchor.quote)}`, `  ancre : ${JSON.stringify(h.anchor)}`)
    }
    data.highlights = highlights.map(h => ({ id: h.id, noteId: h.docId, path: h.path, text: h.anchor.quote, anchor: h.anchor }))
    const sources = found && data.noteId ? [{ docId: found.entry.docId, path: found.entry.path, title: found.entry.path.split('/').pop()?.replace(/\.md$/i, '') ?? found.entry.path }] : []
    return { text: lines.join('\n'), data, ...(sources.length ? { sources } : {}) }
  },
}

const listPins: CoreTool = {
  spec: {
    name: 'list_pins', title: 'Épingles pour l’IA', action: 'read', runtimes: ['app'],
    description: 'Les épingles que la personne a posées pour vous dans ses notes (« Épingler pour l’IA ») : un nom, la note, le passage et son ancre. '
      + 'Appelez-le quand elle cite une épingle par son nom, ou parle de « l’endroit épinglé », « mes épingles ».',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  async run(_args, ctx): Promise<ToolResult> {
    if (!ctx.host.aiMarks) throw new HostError('Les épingles sont indisponibles ici.', 'unavailable')
    const pins = visible(ctx, await ctx.host.aiMarks('pin'))
    if (!pins.length) return { text: 'Aucune épingle pour l’IA.', data: { pins: [] } }
    const lines = pins.flatMap(p => [
      `- ${p.label} : ${p.path} (id : ${p.docId})`,
      `  ${p.anchor.quote === '' ? 'un endroit (curseur)' : quoted(p.anchor.quote)}`,
      `  ancre : ${JSON.stringify(p.anchor)}`,
    ])
    return {
      text: `${pins.length} épingle(s) pour l’IA :\n${lines.join('\n')}`,
      data: { pins: pins.map(p => ({ id: p.id, label: p.label, noteId: p.docId, path: p.path, text: p.anchor.quote, anchor: p.anchor })) },
    }
  },
}

/** Les outils du contexte de l'editeur (appli seulement). */
export const CONTEXT_TOOLS: readonly CoreTool[] = [getContext, listPins]
