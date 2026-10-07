// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Qui fait une action. Une personne, ou un agent qui agit POUR elle.
//
// Un agent n'est pas un compte : il est lance localement par une personne,
// agit en son nom et avec une partie de ses droits. Ce qu'il ecrit reste
// ecrit au nom de cette personne, avec l'indication que c'est l'agent qui
// l'a fait. Cette indication voyage avec la donnee ; elle ne depend d'aucun
// protocole de synchro.

export interface UserActor {
  kind: 'user'
  userId: string
  displayName: string
}

export interface AgentActor {
  kind: 'agent'
  agentId: string
  agentName: string
  /** La personne au nom de qui l'agent agit. */
  onBehalfOf: { userId: string; displayName: string }
}

export type Actor = UserActor | AgentActor

/** « Jean », ou « Relecteur (IA), pour Jean ». */
export function describeActor(actor: Actor): string {
  return actor.kind === 'user'
    ? actor.displayName
    : `${actor.agentName} (IA), pour ${actor.onBehalfOf.displayName}`
}

/** La personne responsable de l'action : elle-meme, ou celle pour qui l'agent agit. */
export function responsibleUserId(actor: Actor): string {
  return actor.kind === 'user' ? actor.userId : actor.onBehalfOf.userId
}
