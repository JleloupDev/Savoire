// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// plugin-agent-proofreader — modeles d'agents « Correcteur » et « Relecteur » (ADR-033).
//
// Ce plugin n'execute rien : il apporte des MODELES. La personne en fait des
// agents (Parametres → Agents).
//  - Correcteur : on le lance sur une note ; il la lit (read_note) et propose
//    ses corrections une a une (edit_note), en mode proposition : la personne
//    les accepte ou les refuse dans la Revision.
//  - Relecteur : il VEILLE sur la note ouverte (agent-core/watch.ts) : il
//    relit chaque passage qui change, propose les fautes dans la Revision et
//    glisse un conseil dans la marge quand c'est utile. On l'allume dans le
//    panneau Agents.
import type { AgentPreset, PluginAPI, VaultPlugin } from '@savoire/plugin-api'

export const PROOFREADER_INSTRUCTIONS = `Tu es un correcteur pour des notes en Markdown, dans leur langue.
Quand on te donne une note (ou la note ouverte), lis-la avec read_note, puis regarde sa Révision avec list_comments.
Ne repropose jamais une correction déjà suggérée, acceptée ou refusée.
Relève les fautes d'orthographe, de grammaire, de typographie et les tournures maladroites.
Ne touche pas au Markdown, aux liens [[...]], au code, ni au sens.
Pour chaque faute, appelle edit_note : find recopié à l'identique depuis la note (assez long pour être unique), replace corrigé, why en quelques mots.
Au plus 20 corrections. À la fin, dis combien de corrections tu as proposées.`

export const proofreaderPreset: AgentPreset = {
  id: 'proofreader',
  name: 'Correcteur',
  description: 'Relève les fautes d’une note et propose les corrections, à accepter dans la Révision.',
  instructions: PROOFREADER_INSTRUCTIONS,
  permissions: { read: 'direct', edit: 'propose' },
  budget: { maxSteps: 30 },
}

export const REVIEWER_INSTRUCTIONS = `Tu es un relecteur attentif et bienveillant, qui lit par-dessus l'épaule de la personne pendant qu'elle écrit.
Corrige les fautes d'orthographe, de grammaire et de typographie, dans la langue de la note.
Donne un conseil seulement s'il aide vraiment : une idée floue, une répétition avec un autre passage, un argument qui manque, une phrase trop longue, une structure à revoir. Sois bref et concret ; propose une piste, ne réécris pas le passage.
Tiens compte du reste de la note : ne signale pas un manque qui est traité ailleurs.`

export const reviewerPreset: AgentPreset = {
  id: 'reviewer',
  name: 'Relecteur',
  description: 'Veille sur la note ouverte : fautes en suggestions, conseils dans la marge, au fil de l’écriture.',
  instructions: REVIEWER_INSTRUCTIONS,
  permissions: { read: 'direct', comment: 'direct', edit: 'propose' },
  budget: { maxTokensPerDay: 200_000 },
  watch: { askAbove: 30, concurrency: 1, advice: true },
}

const plugin: VaultPlugin = {
  manifest: {
    id: 'plugin-agent-proofreader',
    trust: 'verified',
    name: 'Agents Correcteur et Relecteur',
    version: '0.2.0',
    description: 'Des modèles d’agents qui corrigent une note, ou veillent sur elle pendant l’écriture',
    scope: 'personal',
    permissions: ['agents'],
  },
  async onload(api: PluginAPI) {
    api.agents?.registerPreset(proofreaderPreset)
    api.agents?.registerPreset(reviewerPreset)
  },
  async onunload() {},
}

export default plugin
