// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// ─── Outils des agents (ADR-033) ──────────────────────────────────────────
//
// Un outil est une capacite decrite par une fiche : nom, description pour
// l'IA, parametres (schema JSON), action concernee. Le socle en fournit
// (@savoire/agent-core), les plugins en ajoutent (AgentRegistry.registerTool).
//
// La meme fiche sert partout : la boucle de l'appli, le MCP du serveur
// (ChatGPT, Claude) et le pair indexeur qui execute les appels externes.

import type { AgentAction } from './agents'

/** Schema JSON des parametres (sous-ensemble : objet a proprietes). */
export interface ToolInputSchema {
  type: 'object'
  properties: Record<string, ToolParamSchema>
  required?: string[]
  additionalProperties?: false
}

export interface ToolParamSchema {
  type: 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'object'
  description?: string
  enum?: string[]
  items?: ToolParamSchema
  properties?: Record<string, ToolParamSchema>
}

/** Ou un outil peut s'executer. */
export type ToolRuntime = 'app' | 'server'

export interface ToolSpec {
  /** Nom stable, ^[a-z][a-z0-9_]{1,63}$ (un plugin le prefixe : « base_add_row »). */
  name: string
  /** Nom affiche. */
  title: string
  /** Ce que fait l'outil, pour l'IA : quand s'en servir, ce qu'il rend. */
  description: string
  inputSchema: ToolInputSchema
  /** L'action qu'il fait : c'est elle qui decide s'il est permis, et comment. */
  action: AgentAction
  /** Ou il s'execute. Absent : dans l'appli seulement. */
  runtimes?: ToolRuntime[]
}

/** Une note citee par un resultat : la source d'une reponse. */
export interface ToolSource {
  docId: string
  path: string
  title?: string
}

export interface ToolResult {
  /** Ce que l'IA lit. */
  text: string
  /** Le meme resultat, structure (pour l'ecran et les tests). */
  data?: unknown
  /** Notes lues ou trouvees : elles deviennent les sources de la reponse. */
  sources?: ToolSource[]
  isError?: boolean
  /** L'action attend l'accord de la personne. */
  pending?: { approvalId: string }
}

/** Qui agit : l'agent, et la personne pour qui il agit. */
export interface ToolActor {
  agentId: string
  agentName: string
  onBehalfOf: { userId: string; displayName: string }
}

export interface ToolContext {
  /** 'direct' : faire. 'propose' : deposer une proposition dans la Revision. */
  mode: 'direct' | 'propose'
  actor: ToolActor
  signal?: AbortSignal
  /**
   * A appeler avant d'ecrire directement dans le texte d'une note
   * (changeNoteText le fait) : leve si la personne tape dans ce paragraphe.
   * `before` : le texte lu ; `change` : la plage remplacee et son texte.
   * Absent : rien a verifier.
   */
  beforeWrite?(docId: string, before: string, change: { from: number; to: number; text: string }): Promise<void>
}

export const TOOL_NAME = /^[a-z][a-z0-9_]{1,63}$/
