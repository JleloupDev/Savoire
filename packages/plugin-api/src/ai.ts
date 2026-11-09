// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// IA : l'application est gardienne des fournisseurs.
//
//  - La personne branche SES fournisseurs (une adresse, une cle, un modele)
//    dans les reglages. Les cles restent dans l'application : un plugin ne
//    les voit jamais.
//  - Un plugin peut AJOUTER un fournisseur (Mistral, un service maison...) :
//    il le decrit (adresse, protocole, modeles), sans code d'appel. C'est
//    l'application qui fait les appels, avec la cle de la personne.
//  - Tout plugin (un agent, un bloc, une commande) demande une reponse par
//    `api.ai.chat(...)`. Une meme connexion sert a tous les plugins.
//
// L'IA agit avec les droits de la personne qui l'utilise : pas de droits
// propres, pas de compte a elle.

/** Protocoles d'appel que l'application sait parler. */
export type AIProtocol = 'openai'

/**
 * Un fournisseur, decrit par un plugin ou par l'application. Aucune cle ici :
 * la personne la saisit dans les reglages de Savoire.
 */
export interface AIProviderSpec {
  id: string
  /** Nom affiche (« Mistral »). */
  name: string
  protocol: AIProtocol
  /** Adresse de base de l'API (ex. https://api.mistral.ai/v1). Modifiable par la personne. */
  baseUrl: string
  /** Faut-il une cle ? (Ollama en local : non.) */
  requiresKey: boolean
  /** Modeles proposes par defaut ; la personne peut en saisir un autre. */
  models?: string[]
  /** Ou obtenir une cle, pour l'aide des reglages. */
  keyUrl?: string
  description?: string
}

export interface AIMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface AIChatRequest {
  messages: AIMessage[]
  /** Modele ; absent : celui de la connexion. */
  model?: string
  temperature?: number
  maxTokens?: number
  /** Reponse au format JSON (si le fournisseur le permet). */
  json?: boolean
  signal?: AbortSignal
}

export interface AIChatResponse {
  text: string
  model: string
  /** Connexion utilisee (son nom), pour l'afficher. */
  connection: string
  usage?: { inputTokens?: number; outputTokens?: number }
}

/** Une connexion de la personne, telle qu'un plugin peut la voir (sans cle). */
export interface AIConnectionInfo {
  id: string
  name: string
  providerId: string
  model: string
  isDefault: boolean
}

export interface AIAPI {
  /** Une connexion est-elle configuree ? */
  available(): boolean
  connections(): AIConnectionInfo[]
  /** Demande une reponse, par la connexion choisie (defaut : celle par defaut). */
  chat(request: AIChatRequest, connectionId?: string): Promise<AIChatResponse>
  /** Ajoute un fournisseur (plugin). Rend la fonction qui le retire. */
  registerProvider(spec: AIProviderSpec): () => void
}

/** Plus de connexion configuree : la personne doit en ajouter une. */
export class AINotConfiguredError extends Error {
  constructor() {
    super('Aucune IA configurée : ajoutez une connexion dans Paramètres → IA.')
  }
}
