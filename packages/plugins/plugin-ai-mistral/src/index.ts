// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// plugin-ai-mistral — ajoute Mistral AI aux services d'IA de Savoire.
//
// Exemple de fournisseur apporte par un plugin : il DECRIT le service
// (adresse, protocole, modeles). Il ne voit jamais la cle, et ne fait aucun
// appel : la personne saisit sa cle dans Parametres → IA, et c'est
// l'application qui appelle Mistral.
import type { AIProviderSpec, PluginAPI, VaultPlugin } from '@savoire/plugin-api'

export const MISTRAL_PROVIDER: AIProviderSpec = {
  id: 'mistral',
  name: 'Mistral AI',
  protocol: 'openai',
  baseUrl: 'https://api.mistral.ai/v1',
  requiresKey: true,
  models: ['mistral-small-latest', 'mistral-medium-latest', 'mistral-large-latest'],
  keyUrl: 'https://console.mistral.ai/api-keys',
  description: 'Modèles de Mistral AI, hébergés en Europe.',
}

let unregister: (() => void) | null = null

const plugin: VaultPlugin = {
  manifest: {
    id: 'plugin-ai-mistral',
    name: 'Mistral AI',
    version: '0.0.1',
    description: 'Ajoute Mistral AI aux services d’IA (votre clé reste dans Savoire)',
    scope: 'personal',
    permissions: ['ai'],
  },
  async onload(api: PluginAPI) {
    unregister = api.ai?.registerProvider(MISTRAL_PROVIDER) ?? null
  },
  async onunload() {
    unregister?.()
    unregister = null
  },
}

export default plugin
