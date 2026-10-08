// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Agents : des IA qui interviennent dans le vault, lancees localement par une
// personne et rattachees a elle (voir Actor).
//
// Un agent ne recoit jamais l'application entiere. Il recoit un contexte qui
// ne contient que ce que ses droits autorisent, et chaque appel est verifie.
// Ses droits effectifs sont l'INTERSECTION de deux choses :
//   - le mode dans lequel on le lance (lecture, relecture, redaction) ;
//   - les droits de la personne qui le lance.
// Un agent lance par un lecteur du vault ne peut donc jamais ecrire, quel que
// soit son mode.
//
// Ces modes sont des roles d'AGENT, distincts des roles de vault du serveur.
// Pour l'instant les agents parlent a l'application, pas aux plugins.
import type { VaultClient } from '@savoire/platform'
import type { AgentActor } from './Actor'
import type { IVaultSyncSession } from './contracts'
import type { ReviewEntry, ReviewService, ReviewThread } from './ReviewService'

export type AgentCapability =
  | 'documents.read'
  | 'documents.write'
  | 'index.query'
  | 'review.read'
  | 'review.write'

export interface AgentMode {
  id: 'read' | 'review' | 'write'
  label: string
  description: string
  capabilities: AgentCapability[]
}

export const AGENT_MODES: AgentMode[] = [
  {
    id: 'read',
    label: 'Lecture',
    description: 'Lit les notes et consulte les index. N’écrit rien.',
    capabilities: ['documents.read', 'index.query', 'review.read'],
  },
  {
    id: 'review',
    label: 'Relecture',
    description: 'Lit, consulte les index et commente. Ne touche pas aux notes.',
    capabilities: ['documents.read', 'index.query', 'review.read', 'review.write'],
  },
  {
    id: 'write',
    label: 'Rédaction',
    description: 'Lit, commente, et écrit dans les notes.',
    capabilities: ['documents.read', 'index.query', 'review.read', 'review.write', 'documents.write'],
  },
]

/** Droits d'une personne dans le vault, vus comme des capacites d'agent. */
export function userCapabilities(user: { canWrite: boolean }): AgentCapability[] {
  const base: AgentCapability[] = ['documents.read', 'index.query', 'review.read']
  return user.canWrite ? [...base, 'review.write', 'documents.write'] : base
}

/** Mode ∩ droits de la personne. */
export function effectiveCapabilities(mode: AgentMode, user: { canWrite: boolean }): Set<AgentCapability> {
  const allowed = new Set(userCapabilities(user))
  return new Set(mode.capabilities.filter(c => allowed.has(c)))
}

export class AgentPermissionError extends Error {
  constructor(readonly capability: AgentCapability) {
    super(`droit refuse a l'agent : ${capability}`)
  }
}

export interface AgentContextDeps {
  actor: AgentActor
  capabilities: ReadonlySet<AgentCapability>
  client: VaultClient
  session: IVaultSyncSession
  review: ReviewService
}

/** Tout ce qu'un agent peut faire, et rien d'autre. Chaque appel est verifie. */
export class AgentContext {
  readonly log: string[] = []

  constructor(private readonly deps: AgentContextDeps) {}

  get actor(): AgentActor {
    return this.deps.actor
  }

  can(capability: AgentCapability): boolean {
    return this.deps.capabilities.has(capability)
  }

  note(line: string): void {
    this.log.push(line)
  }

  readonly documents = {
    read: (docId: string): Promise<string> => {
      this.require('documents.read')
      return this.deps.client.read(docId)
    },
    /** Ecrit a la fin de la note, en son nom de personne, avec la trace de l'agent. */
    append: (docId: string, text: string): void => {
      this.require('documents.write')
      this.deps.session.appendText(docId, text)
      this.deps.review.recordEdit(docId, `A ajouté ${text.trim().length} caractères à la fin de la note.`, this.deps.actor)
    },
  }

  readonly index = {
    /** Note designee par un lien [[cible]], si elle existe. */
    resolveLink: (target: string): { id: string; path: string } | null => {
      this.require('index.query')
      const id = this.deps.client.resolveDocumentId(target)
      const doc = id ? this.deps.client.documents.find(d => d.id === id) : undefined
      return doc ? { id: doc.id, path: doc.path } : null
    },
    listDocuments: (): { id: string; path: string }[] => {
      this.require('index.query')
      return this.deps.client.documents.map(d => ({ id: d.id, path: d.path }))
    },
  }

  readonly review = {
    list: (docId: string): ReviewEntry[] => {
      this.require('review.read')
      return this.deps.review.list(docId)
    },
    threads: (docId: string): ReviewThread[] => {
      this.require('review.read')
      return this.deps.review.threads(docId)
    },
    comment: (docId: string, text: string): ReviewEntry => {
      this.require('review.write')
      return this.deps.review.comment(docId, text, this.deps.actor)
    },
    reply: (rootId: string, text: string): ReviewEntry => {
      this.require('review.write')
      return this.deps.review.reply(rootId, text, this.deps.actor)
    },
  }

  private require(capability: AgentCapability): void {
    if (!this.can(capability)) throw new AgentPermissionError(capability)
  }
}

export interface AgentDefinition {
  id: string
  name: string
  description: string
  run(ctx: AgentContext, target: { docId: string; path: string }): Promise<void>
}

export interface AgentRunResult {
  ok: boolean
  log: string[]
  capabilities: AgentCapability[]
}

export interface RunAgentParams {
  agent: AgentDefinition
  mode: AgentMode
  user: { userId: string; displayName: string; canWrite: boolean }
  target: { docId: string; path: string }
  client: VaultClient
  session: IVaultSyncSession
  review: ReviewService
}

/** Lance un agent sur une note, avec les droits mode ∩ personne. */
export async function runAgent(p: RunAgentParams): Promise<AgentRunResult> {
  const capabilities = effectiveCapabilities(p.mode, p.user)
  const ctx = new AgentContext({
    actor: {
      kind: 'agent',
      agentId: p.agent.id,
      agentName: p.agent.name,
      onBehalfOf: { userId: p.user.userId, displayName: p.user.displayName },
    },
    capabilities,
    client: p.client,
    session: p.session,
    review: p.review,
  })
  try {
    await p.agent.run(ctx, p.target)
    return { ok: true, log: ctx.log, capabilities: [...capabilities] }
  } catch (err) {
    ctx.note(`Arrêt : ${err instanceof Error ? err.message : String(err)}`)
    return { ok: false, log: ctx.log, capabilities: [...capabilities] }
  }
}
