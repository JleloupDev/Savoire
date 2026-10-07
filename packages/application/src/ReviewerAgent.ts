// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Agent scripte de demonstration : un relecteur sans modele de langage. Il
// sert a eprouver la tuyauterie (droits, attribution, couche de revision)
// avant de brancher une vraie IA.
//
// Il lit la note, compte les mots, releve les TODO et verifie chaque lien
// [[...]] par l'index. Ensuite, selon ses droits :
//   - relecture : il poste ses remarques en commentaire ;
//   - redaction : il ajoute aussi une ligne de synthese a la fin de la note.
import type { AgentContext, AgentDefinition } from './Agents'

export interface ReviewFindings {
  words: number
  todos: number
  brokenLinks: string[]
}

/** Cible d'un lien [[cible|alias]] ou [[cible#titre]]. */
function linkTargets(text: string): string[] {
  const targets = new Set<string>()
  for (const m of text.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const target = m[1].split('|')[0].split('#')[0].trim()
    if (target) targets.add(target)
  }
  return [...targets]
}

export function reviewText(text: string, resolve: (target: string) => unknown): ReviewFindings {
  return {
    words: (text.match(/[\p{L}\p{N}]+/gu) ?? []).length,
    todos: (text.match(/\bTODO\b/g) ?? []).length,
    brokenLinks: linkTargets(text).filter(t => !resolve(t)),
  }
}

export function summarize(f: ReviewFindings): string {
  const parts = [`${f.words} mots`]
  parts.push(f.todos === 0 ? 'aucun TODO' : `${f.todos} TODO à traiter`)
  parts.push(f.brokenLinks.length === 0
    ? 'tous les liens mènent à une note'
    : `liens sans note : ${f.brokenLinks.map(l => `[[${l}]]`).join(', ')}`)
  return `Relecture : ${parts.join(' ; ')}.`
}

export const reviewerAgent: AgentDefinition = {
  id: 'agent-reviewer',
  name: 'Relecteur',
  description: 'Compte les mots, relève les TODO et vérifie les liens de la note.',

  async run(ctx: AgentContext, target) {
    const text = await ctx.documents.read(target.docId)
    const findings = reviewText(text, t => ctx.index.resolveLink(t))
    const summary = summarize(findings)
    ctx.note(summary)

    if (ctx.can('review.write')) {
      ctx.review.comment(target.docId, summary)
      ctx.note('Commentaire posté dans la révision.')
    } else {
      ctx.note('Pas le droit de commenter dans ce mode : résultat gardé ici.')
    }

    if (ctx.can('documents.write')) {
      ctx.documents.append(target.docId, `\n\n> ${summary}\n`)
      ctx.note('Synthèse ajoutée à la fin de la note.')
    }
  },
}

export const AGENTS: AgentDefinition[] = [reviewerAgent]
