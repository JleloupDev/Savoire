// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// plugin-agent-proofreader — agent « Correcteur (IA) ».
//
// Un type d'agent qui s'appuie sur l'IA de la personne (ses connexions,
// tenues par l'application : l'agent ne voit aucune cle). Il demande au
// modele les fautes de la note, sous forme de passages a remplacer, puis :
//   - lecture : il garde ses trouvailles dans le journal ;
//   - relecture : il les poste en commentaire ;
//   - suggestion, redaction : il les propose comme suggestions, que la
//     personne accepte ou refuse une a une. Il n'ecrit jamais lui-meme.
import type { AgentRunContext, AgentSpec, AgentTarget, PluginAPI, VaultPlugin } from '@savoire/plugin-api'

export interface Correction { find: string; replace: string; why?: string }

/** Au plus, par passage de l'agent. */
export const MAX_CORRECTIONS = 20
/** Au-dela, la note est coupee (le modele n'en verrait pas la fin de toute facon). */
const MAX_CHARS = 20_000

export const PROMPT = `Tu es un correcteur pour des notes en Markdown, dans leur langue.
Relève les fautes d'orthographe, de grammaire, de typographie et les tournures maladroites.
Ne touche pas au Markdown, aux liens [[...]], au code, ni au sens.
Réponds UNIQUEMENT en JSON : {"corrections":[{"find":"passage exact de la note","replace":"passage corrigé","why":"raison courte"}]}.
"find" doit être recopié à l'identique depuis la note, assez long pour être unique (quelques mots).
Au plus ${MAX_CORRECTIONS} corrections. Aucune faute : {"corrections":[]}.`

/** Les corrections lues dans la reponse du modele (tolerant : texte autour, bloc ```json). */
export function parseCorrections(answer: string): Correction[] {
  const start = answer.indexOf('{')
  const end = answer.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  try {
    const data = JSON.parse(answer.slice(start, end + 1)) as { corrections?: unknown }
    if (!Array.isArray(data.corrections)) return []
    return data.corrections
      .filter((c): c is Correction => !!c && typeof (c as Correction).find === 'string' && typeof (c as Correction).replace === 'string')
      .filter(c => c.find && c.find !== c.replace)
      .slice(0, MAX_CORRECTIONS)
  } catch {
    return []
  }
}

export const proofreaderAgent: AgentSpec = {
  id: 'agent-proofreader',
  name: 'Correcteur (IA)',
  description: 'Relève les fautes de la note avec votre IA, et les propose en suggestions.',
  requires: ['documents.read', 'review.read', 'review.write', 'review.suggest'],
  async run(ctx: AgentRunContext, target: AgentTarget) {
    if (!ctx.ai) {
      ctx.note('Aucune IA configurée : ajoutez une connexion dans Paramètres → IA.')
      return
    }
    const text = (await ctx.documents.read(target.docId)).slice(0, MAX_CHARS)
    if (!text.trim()) { ctx.note('Note vide : rien à corriger.'); return }
    const answer = await ctx.ai.chat({
      messages: [{ role: 'system', content: PROMPT }, { role: 'user', content: text }],
      temperature: 0,
      json: true,
    })
    ctx.note(`Réponse de ${answer.model} (${answer.connection}).`)
    const corrections = parseCorrections(answer.text).filter(c => text.includes(c.find))
    if (corrections.length === 0) { ctx.note('Aucune faute relevée.'); return }

    if (ctx.can('review.suggest') && ctx.review.suggest) {
      let n = 0
      for (const c of corrections) if (ctx.review.suggest(target.docId, c.find, c.replace, c.why ?? 'Correction')) n++
      ctx.note(`${n} suggestion(s) à accepter ou refuser dans la Révision.`)
      return
    }
    const list = corrections.map(c => `- « ${c.find} » → « ${c.replace} »${c.why ? ` (${c.why})` : ''}`).join('\n')
    if (ctx.can('review.write')) {
      ctx.review.comment(target.docId, `Corrections proposées :\n${list}`)
      ctx.note(`${corrections.length} correction(s) postée(s) en commentaire.`)
    } else {
      ctx.note(`Corrections :\n${list}`)
    }
  },
}

const plugin: VaultPlugin = {
  manifest: {
    id: 'plugin-agent-proofreader',
    name: 'Agent Correcteur (IA)',
    version: '0.0.1',
    description: 'Un agent qui corrige la note avec votre IA, en suggestions à accepter',
    scope: 'personal',
    permissions: ['agents'],
  },
  async onload(api: PluginAPI) {
    api.agents?.register(proofreaderAgent)
  },
  async onunload() {},
}

export default plugin
