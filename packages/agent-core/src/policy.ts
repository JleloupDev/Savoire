// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Droits d'un agent (ADR-033) : un mode par action, borne par les droits de
// la personne pour qui il agit, et par sa portee (vaults, dossiers).
//
// Les memes regles servent dans l'appli et sur le pair indexeur ; le serveur
// Rust en garde une copie courte (backend/src/api/agents.rs), verifiee par
// les memes cas de test.
import {
  AGENT_ACTION_MODES, AGENT_ACTIONS,
  type AgentAction, type AgentActionMode, type AgentDefinition, type AgentPermissions, type AgentScope,
} from '@savoire/plugin-api'

/** Ce que la personne peut faire dans le vault. Les ACL par note sont verifiees a l'ecriture. */
export interface PersonRights {
  canWrite: boolean
}

/** Un mode valide pour cette action, sinon 'deny'. */
export function normalizeMode(action: AgentAction, mode: unknown): AgentActionMode {
  return (AGENT_ACTION_MODES[action] as readonly unknown[]).includes(mode) ? mode as AgentActionMode : 'deny'
}

/** Des droits propres : chaque action a un mode qui a du sens pour elle. */
export function normalizePermissions(p: AgentPermissions | undefined): Required<AgentPermissions> {
  const out = {} as Required<AgentPermissions>
  for (const a of AGENT_ACTIONS) out[a] = normalizeMode(a, p?.[a])
  return out
}

/**
 * Le mode effectif d'une action : celui de l'agent, sauf si la personne ne
 * peut pas ecrire (un lecteur ne fait jamais ecrire un agent, quel que soit
 * son mode).
 */
export function effectiveMode(agent: Pick<AgentDefinition, 'permissions'>, action: AgentAction, person: PersonRights): AgentActionMode {
  const mode = normalizeMode(action, agent.permissions?.[action])
  // Deleguer n'ecrit rien : le sous-agent, lui, reste borne par la personne.
  if (action !== 'read' && action !== 'delegate' && !person.canWrite) return 'deny'
  return mode
}

/** Dossier normalise : sans « / » au debut ni a la fin. */
export function normalizeFolder(folder: string): string {
  return folder.trim().replace(/^\/+|\/+$/g, '')
}

/** Le vault est-il dans la portee de l'agent ? */
export function vaultInScope(scope: AgentScope | undefined, vaultId: string): boolean {
  return !scope?.vaultIds?.length || scope.vaultIds.includes(vaultId)
}

/** Le chemin est-il dans la portee de l'agent ? (sous-dossiers compris) */
export function pathInScope(scope: AgentScope | undefined, path: string): boolean {
  const folders = (scope?.folders ?? []).map(normalizeFolder).filter(f => f !== '')
  if (!folders.length) return true
  const p = normalizeFolder(path)
  return folders.some(f => p === f || p.startsWith(f + '/'))
}

const RANK: Record<AgentActionMode, number> = { deny: 0, ask: 1, propose: 2, direct: 3 }

/** Le plus prudent de deux modes ('ask' et 'propose' : 'ask', on demande toujours avant). */
export function stricterMode(a: AgentActionMode, b: AgentActionMode): AgentActionMode {
  if (a === 'deny' || b === 'deny') return 'deny'
  if (a === 'ask' || b === 'ask') return 'ask'
  return RANK[a] <= RANK[b] ? a : b
}

/**
 * Un sous-agent n'a jamais plus que son parent : pour chaque action, le plus
 * prudent des deux modes ; sa portee est celle du parent, restreinte par la
 * sienne si elle est plus precise.
 */
export function narrowAgent(parent: AgentDefinition, child: AgentDefinition): AgentDefinition {
  const pp = normalizePermissions(parent.permissions)
  const cp = normalizePermissions(child.permissions)
  const permissions: AgentPermissions = {}
  for (const a of AGENT_ACTIONS) permissions[a] = stricterMode(pp[a], cp[a])
  return { ...child, permissions, scope: narrowScope(parent.scope, child.scope) }
}

/** Profondeur maximale d'une delegation (orchestrateur -> sous-agent -> ...). */
export const MAX_DELEGATION_DEPTH = 3

/**
 * Les agents a qui cet agent peut confier une tache : ceux de sa liste,
 * connus, et jamais lui-meme.
 */
export function delegableAgents(agent: AgentDefinition, known: readonly AgentDefinition[]): AgentDefinition[] {
  const ids = new Set(agent.delegates ?? [])
  return known.filter(a => ids.has(a.id) && a.id !== agent.id)
}

function narrowScope(parent: AgentScope | undefined, child: AgentScope | undefined): AgentScope | undefined {
  const vaultIds = !parent?.vaultIds?.length ? child?.vaultIds
    : !child?.vaultIds?.length ? parent.vaultIds
    : child.vaultIds.filter(v => parent.vaultIds!.includes(v))
  const pf = parent?.folders?.filter(f => normalizeFolder(f)) ?? []
  const cf = child?.folders?.filter(f => normalizeFolder(f)) ?? []
  // Un dossier du fils n'est garde que s'il est dans un dossier du parent.
  const folders = !pf.length ? cf : !cf.length ? pf : cf.filter(f => pathInScope({ folders: pf }, f))
  if (!vaultIds?.length && !folders.length) return undefined
  return { ...(vaultIds?.length ? { vaultIds } : {}), ...(folders.length ? { folders } : {}) }
}

/** Les droits d'un agent, en une phrase par action (pour l'ecran et pour l'IA). */
export const ACTION_LABELS: Record<AgentAction, string> = {
  read: 'Lire et chercher',
  comment: 'Commenter',
  edit: 'Modifier les notes',
  create: 'Créer des notes et des dossiers',
  organize: 'Déplacer et renommer',
  delete: 'Mettre à la corbeille',
  plugin: 'Actions des plugins',
  delegate: 'Déléguer à un sous-agent',
}

export const MODE_LABELS: Record<AgentActionMode, string> = {
  direct: 'Oui',
  ask: 'Demander avant',
  propose: 'Proposer (Révision)',
  deny: 'Non',
}
