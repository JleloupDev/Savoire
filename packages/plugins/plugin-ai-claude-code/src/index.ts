// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// plugin-ai-claude-code — parler a Claude avec son propre abonnement, par
// le programme Claude Code installe sur cet ordinateur. Application de
// bureau seulement ; chacun l'active pour soi.
//
// Comme plugin-ai-mistral, il DECRIT le fournisseur et ne fait aucun appel.
// Son protocole, « claude-cli », est servi par l'application de bureau :
// elle lance le programme `claude` de la personne, qui se sert de sa propre
// connexion. Savoire ne lit jamais les identifiants de Claude Code. Une cle
// d'API reste possible a cote, par une connexion classique.
import type { AIProviderSpec, PluginAPI, VaultPlugin } from '@savoire/plugin-api'

export const CLAUDE_CODE_PROVIDER: AIProviderSpec = {
  id: 'claude-code',
  name: 'Claude (abonnement, sur cet ordinateur)',
  protocol: 'claude-cli',
  baseUrl: '',
  requiresKey: false,
  models: ['sonnet', 'opus', 'haiku'],
  description: 'Votre abonnement Claude, par Claude Code installé sur cet ordinateur. Savoire lance le programme claude ; il ne lit pas vos identifiants. Usage personnel, application de bureau seulement.',
}

let unregister: (() => void) | null = null

const plugin: VaultPlugin = {
  manifest: {
    id: 'plugin-ai-claude-code',
    trust: 'verified',
    name: 'Claude (abonnement)',
    version: '0.0.1',
    description: 'Parler à Claude avec votre abonnement, par Claude Code installé sur cet ordinateur (application de bureau)',
    scope: 'personal',
    permissions: ['ai'],
  },
  async onload(api: PluginAPI) {
    try {
      unregister = api.ai?.registerProvider(CLAUDE_CODE_PROVIDER) ?? null
    } catch {
      // Hors de l'application de bureau, aucun programme a lancer : rien a ajouter.
      unregister = null
    }
  },
  async onunload() {
    unregister?.()
    unregister = null
  },
}

export default plugin
