// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// ─── Agents ───────────────────────────────────────────────────────────────
//
// Un plugin peut proposer des agents : des IA (ou des scripts) qui
// interviennent dans le vault. Un agent n'est pas un compte. Il est lance
// localement par une personne, agit en son nom et avec une partie de ses
// droits. Ce qu'il fait porte « Agent (IA), pour Jean ».
//
// Droits effectifs = ce que l'agent demande (requires)
//                  ∩ le mode choisi au lancement (lecture, relecture...)
//                  ∩ les droits de la personne qui le lance.
//
// Pendant son execution, l'agent ne recoit JAMAIS la PluginAPI : seulement un
// AgentRunContext, ou chaque appel est verifie. Un agent appartient a son
// plugin : desactiver ou desinstaller le plugin retire l'agent.
//
// Niveau de confiance 1 : ces droits encadrent ce que l'application execute
// pour l'agent. Ils n'empechent pas le code du plugin d'utiliser ailleurs la
// PluginAPI complete.

export type AgentCapability =
  | 'documents.read'
  | 'documents.write'
  | 'index.query'
  | 'review.read'
  | 'review.write'

export interface AgentTarget {
  docId: string
  path: string
}

/** Une entree de la revision, telle qu'un agent la voit. */
export interface AgentReviewEntry {
  id: string
  kind: 'comment' | 'edit'
  text: string
  /** « Jean », ou « Relecteur (IA), pour Jean ». */
  author: string
  authorIsAgent: boolean
  createdAt: string
  status?: 'open' | 'resolved' | 'rejected'
}

export interface AgentReviewThread {
  root: AgentReviewEntry
  replies: AgentReviewEntry[]
}

export interface AgentRunContext {
  /** Qui agit : l'agent, et la personne pour qui il agit. */
  readonly actor: { agentName: string; onBehalfOf: { displayName: string } }
  /** L'agent a-t-il ce droit pour cette execution ? */
  can(capability: AgentCapability): boolean
  /** Journal de l'execution, montre a la personne qui a lance l'agent. */
  note(line: string): void

  documents: {
    read(docId: string): Promise<string>
    /** Ajoute a la fin d'une note ouverte. L'ecriture est tracee dans la revision. */
    append(docId: string, text: string): void
  }
  index: {
    /** Note designee par un lien [[cible]], si elle existe. */
    resolveLink(target: string): { id: string; path: string } | null
    listDocuments(): { id: string; path: string }[]
  }
  review: {
    threads(docId: string): AgentReviewThread[]
    comment(docId: string, text: string): void
    reply(rootId: string, text: string): void
  }
}

export interface AgentSpec {
  id: string
  name: string
  description: string
  /** Le maximum dont l'agent a besoin. Il n'aura jamais plus. */
  requires: AgentCapability[]
  run(ctx: AgentRunContext, target: AgentTarget): Promise<void>
}

export interface AgentRegistry {
  register(spec: AgentSpec): void
  /** Agents des plugins actifs. */
  getAll(): AgentSpec[]
}
