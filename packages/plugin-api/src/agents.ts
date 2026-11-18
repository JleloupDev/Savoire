// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// ─── Agents (ADR-033) ─────────────────────────────────────────────────────
//
// Un agent est une IDENTITE declaree dans l'application : un nom, des
// consignes, une portee, des droits par action, un budget. Ce n'est pas une
// IA : l'IA (le modele de la personne, ou ChatGPT) « porte » l'agent. C'est le
// nom de l'agent qui figure sur ce qu'il fait : « Archiviste (IA), pour Jean ».
//
// Un agent agit toujours POUR une personne. Droits effectifs = droits de
// l'agent ∩ droits de cette personne.
//
// Un plugin peut apporter :
//  - des MODELES d'agents (registerPreset) : la personne en fait un agent ;
//  - des OUTILS (registerTool, voir tools.ts) que les agents utilisent.

import type { ToolContext, ToolResult, ToolSpec } from './tools'

/** Ce qu'un agent peut faire. Lire ne donne jamais le droit d'ecrire. */
export type AgentAction = 'read' | 'comment' | 'edit' | 'create' | 'organize' | 'delete' | 'plugin'

/**
 * Comment une action est faite :
 *  - 'direct'  : l'outil s'execute ;
 *  - 'ask'     : l'action attend l'accord de la personne, dans Savoire ;
 *  - 'propose' : l'outil depose une proposition dans la Revision ;
 *  - 'deny'    : l'outil n'est meme pas propose a l'IA.
 */
export type AgentActionMode = 'direct' | 'ask' | 'propose' | 'deny'

/** Les modes qui ont un sens pour chaque action. */
export const AGENT_ACTION_MODES: Record<AgentAction, readonly AgentActionMode[]> = {
  read: ['direct', 'deny'],
  comment: ['direct', 'ask', 'deny'],
  edit: ['direct', 'ask', 'propose', 'deny'],
  create: ['direct', 'ask', 'deny'],
  organize: ['direct', 'ask', 'deny'],
  delete: ['direct', 'ask', 'deny'],
  plugin: ['direct', 'ask', 'propose', 'deny'],
}

export const AGENT_ACTIONS: readonly AgentAction[] = ['read', 'comment', 'edit', 'create', 'organize', 'delete', 'plugin']

/** Droits d'un agent : un mode par action. Une action absente est interdite. */
export type AgentPermissions = Partial<Record<AgentAction, AgentActionMode>>

/** Ou l'agent a le droit d'aller. Absent : partout ou la personne peut aller. */
export interface AgentScope {
  /** Vaults permis (ids). */
  vaultIds?: string[]
  /** Dossiers permis (« Projets/2026 »), sous-dossiers compris. */
  folders?: string[]
}

export interface AgentBudget {
  /** Etapes au plus par execution (appels au modele et aux outils). */
  maxSteps?: number
  /** Tokens au plus par execution (entree + sortie). */
  maxTokensPerRun?: number
  /** Tokens au plus par jour, toutes executions confondues. */
  maxTokensPerDay?: number
}

/** Un agent declare. */
export interface AgentDefinition {
  id: string
  name: string
  description: string
  /** Les consignes donnees a l'IA (le prompt de l'agent). */
  instructions: string
  /** La personne a qui il appartient. */
  ownerId: string
  /** Agent du vault (partage par ses membres). Absent : agent personnel. */
  vaultId?: string
  permissions: AgentPermissions
  scope?: AgentScope
  budget?: AgentBudget
  /** Connexion d'IA a utiliser dans l'appli (AIConnectionInfo.id). Absente : celle par defaut. */
  connectionId?: string
  model?: string
  /** D'ou il vient : fait a la main, ou d'un modele d'un plugin. */
  source?: { kind: 'manual' } | { kind: 'preset'; pluginId: string; presetId: string }
  createdAt?: string
  updatedAt?: string
}

/** Un modele d'agent, apporte par un plugin (store). */
export interface AgentPreset {
  id: string
  name: string
  description: string
  instructions: string
  permissions: AgentPermissions
  budget?: AgentBudget
  /** Agent de vault conseille (ranger, jardiner...) plutot que personnel. */
  vaultScoped?: boolean
}

/** Un outil apporte par un plugin. Il s'execute dans l'application, avec la PluginAPI du plugin. */
export interface PluginTool {
  spec: ToolSpec
  /**
   * Execute l'outil. `ctx.mode` dit s'il faut faire ('direct') ou proposer
   * ('propose', par api.review.propose). L'application a deja verifie les
   * droits de l'agent.
   */
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>
}

export interface AgentRegistry {
  /** Ajoute un modele d'agent. Rend la fonction qui le retire. */
  registerPreset(preset: AgentPreset): () => void
  /** Modeles des plugins actifs. */
  presets(): AgentPreset[]
  /** Ajoute un outil. Rend la fonction qui le retire. */
  registerTool(tool: PluginTool): () => void
  /** Outils des plugins actifs. */
  tools(): PluginTool[]
}
