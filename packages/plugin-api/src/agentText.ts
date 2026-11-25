// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Pour les outils d'agent des plugins (ADR-033) : modifier le texte d'une
// note, ou le PROPOSER, selon le mode que l'application a decide. La
// proposition est une proposition de texte (« savoire.text ») : la personne
// l'accepte ou la refuse dans la Revision, comme celles des editeurs.
import type { PluginAPI } from './plugin-api'
import { TEXT_PROPOSAL, type TextProposalPayload } from './review'
import type { ToolContext } from './tools'

/** La plus petite plage qui fait passer de `before` a `after`. */
export function minimalChange(before: string, after: string): { from: number; to: number; text: string } {
  let start = 0
  const max = Math.min(before.length, after.length)
  while (start < max && before[start] === after[start]) start++
  let end = 0
  while (end < max - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++
  return { from: start, to: before.length - end, text: after.slice(start, after.length - end) }
}

const CONTEXT = 40

/**
 * Applique `edit` au texte de la note (mode 'direct'), ou depose la
 * modification en proposition (mode 'propose'). Rend 'unchanged' si rien ne
 * change.
 */
export async function changeNoteText(
  api: Pick<PluginAPI, 'vault' | 'review'>,
  ctx: Pick<ToolContext, 'mode' | 'actor' | 'beforeWrite'>,
  docId: string,
  edit: (current: string) => string,
  note: string,
): Promise<'done' | 'proposed' | 'unchanged'> {
  const current = await api.vault.read(docId)
  const next = edit(current)
  if (next === current) return 'unchanged'
  if (ctx.mode === 'propose') {
    if (!api.review) throw new Error('Révision indisponible.')
    const c = minimalChange(current, next)
    const payload: TextProposalPayload = {
      at: c.from, before: current.slice(c.from, c.to), after: c.text,
      context: { left: current.slice(Math.max(0, c.from - CONTEXT), c.from), right: current.slice(c.to, c.to + CONTEXT) },
    }
    await api.review.propose(docId, TEXT_PROPOSAL, payload, `${ctx.actor.agentName} : ${note}`)
    return 'proposed'
  }
  if (typeof api.vault.editText !== 'function') throw new Error('Ce vault ne permet pas de modifier la note.')
  // Jamais dans le paragraphe ou la personne tape : l'application le verifie (elle leve).
  await ctx.beforeWrite?.(docId, current, minimalChange(current, next))
  // Sur le texte du moment : une frappe a pu arriver entre-temps.
  await api.vault.editText(docId, edit)
  return 'done'
}

/** Une note par son chemin (ou son id) : son id et son chemin, ou une erreur claire. */
export function noteRef(api: Pick<PluginAPI, 'vault'>, ref: unknown): { id: string; path: string } {
  if (typeof ref !== 'string' || !ref.trim()) throw new Error('Donnez la note (chemin).')
  const wanted = ref.trim()
  const tree = api.vault.getFileTree?.() ?? []
  const hit = tree.find(f => f.docId === wanted || f.path === wanted)
    ?? tree.find(f => f.path.toLowerCase() === wanted.toLowerCase() || f.path.toLowerCase() === `${wanted.toLowerCase()}.md`)
  if (hit) return { id: hit.docId, path: hit.path }
  const id = api.vault.resolveDocumentId(wanted) ?? api.vault.resolveDocumentId(`${wanted}.md`)
  if (!id) throw new Error(`Note introuvable : ${wanted}.`)
  return { id, path: wanted.endsWith('.md') ? wanted : `${wanted}.md` }
}
