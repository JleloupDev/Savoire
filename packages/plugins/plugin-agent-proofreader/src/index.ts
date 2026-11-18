// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// plugin-agent-proofreader — modele d'agent « Correcteur » (ADR-033).
//
// Ce plugin n'execute rien : il apporte un MODELE. La personne en fait un
// agent (Parametres → Agents), qui utilise les outils du socle : il lit la
// note (read_note) et propose ses corrections une a une (edit_note), en mode
// proposition par defaut : la personne les accepte ou les refuse dans la
// Revision.
import type { AgentPreset, PluginAPI, VaultPlugin } from '@savoire/plugin-api'

export const PROOFREADER_INSTRUCTIONS = `Tu es un correcteur pour des notes en Markdown, dans leur langue.
Quand on te donne une note (ou la note ouverte), lis-la avec read_note.
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

const plugin: VaultPlugin = {
  manifest: {
    id: 'plugin-agent-proofreader',
    name: 'Agent Correcteur',
    version: '0.1.0',
    description: 'Un modèle d’agent qui corrige une note, en suggestions à accepter',
    scope: 'personal',
    permissions: ['agents'],
  },
  async onload(api: PluginAPI) {
    api.agents?.registerPreset(proofreaderPreset)
  },
  async onunload() {},
}

export default plugin
