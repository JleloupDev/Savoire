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

/**
 * Protocoles d'appel que l'application sait parler (un adaptateur par
 * protocole, dans AIService). « openai » seulement pour l'instant.
 */
export type AIProtocol = 'openai' | (string & {})

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
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** Message 'assistant' : les outils que le modele demande. */
  toolCalls?: AIToolCall[]
  /** Message 'tool' : l'appel auquel il repond. */
  toolCallId?: string
}

/** Un outil propose au modele (format « fonction » d'OpenAI). */
export interface AIToolDefinition {
  name: string
  description: string
  /** Schema JSON des parametres. */
  parameters: object
}

/** Un appel d'outil demande par le modele. `arguments` : du JSON, tel que le modele l'a ecrit. */
export interface AIToolCall {
  id: string
  name: string
  arguments: string
}

export interface AIChatRequest {
  messages: AIMessage[]
  /** Modele ; absent : celui de la connexion. */
  model?: string
  temperature?: number
  maxTokens?: number
  /** Reponse au format JSON (si le fournisseur le permet). */
  json?: boolean
  /** Outils que le modele peut demander. */
  tools?: AIToolDefinition[]
  /**
   * Reponse au fil de l'eau : appele a chaque morceau recu (texte, appel
   * d'outil en cours). Present : l'application demande un flux au
   * fournisseur, et retombe sur une reponse entiere s'il le refuse. La
   * reponse finale (chat) reste la meme.
   */
  onDelta?(delta: AIStreamDelta): void
  signal?: AbortSignal
}

/** Un morceau de reponse en flux. */
export interface AIStreamDelta {
  /** Texte ajoute a la reponse. */
  text?: string
  /** Un appel d'outil qui se construit (nom, puis morceaux d'arguments). */
  toolCall?: { index: number; name?: string; arguments?: string }
}

export interface AIChatResponse {
  text: string
  model: string
  /** Connexion utilisee (son nom), pour l'afficher. */
  connection: string
  usage?: { inputTokens?: number; outputTokens?: number }
  /** Outils demandes par le modele (texte souvent vide alors). */
  toolCalls?: AIToolCall[]
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
