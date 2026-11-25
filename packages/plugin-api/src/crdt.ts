// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup

import type { ICollaborativeText, CrdtVersion } from '@savoire/domain-index'

/** Un agent IA present dans la note : ce qu'il fait, et ou (positions dans le texte du moment). */
export interface AgentPeer {
  /** Stable tant qu'il est la (son clientID d'awareness). */
  key: string
  name: string
  /** « #rrggbb ». */
  color: string
  state: 'reading' | 'writing'
  /** Passage lu, ou passage qu'il vient d'ecrire (le curseur est a `to`). Absents : pas de position. */
  from?: number
  to?: number
  /** La personne pour qui il agit. */
  onBehalfOf?: string
}

/** L'agent qui se montre, et ce qu'il fait (null : il part). */
export interface AgentPresenceInput {
  agent: { id: string; name: string; color: string; onBehalfOf?: string }
  activity: { state: 'reading' | 'writing'; from?: number; to?: number } | null
}

// ── Modifications de l'IA (infrastructure-sync/AiChanges.ts) ────────────────

/** Une personne, dans un point de modification de l'IA. */
export interface AiChangeWho { id: string; name: string }

/**
 * Une intervention d'un agent dans la note, telle qu'on la montre : un point
 * annulable seul. Apres quelques minutes, les points d'un meme agent sont
 * compactes : `count` ecritures, `parts` les points ranges qu'il regroupe.
 */
export interface AiChangeInfo {
  /** Id montre (celui du premier point range). */
  id: string
  /** Les points ranges qu'il regroupe : tous partent ensemble a l'annulation. */
  parts: string[]
  /** Date ISO de la premiere ecriture. */
  at: string
  /** Date ISO de la derniere, si plusieurs. */
  last?: string
  agent: { id: string; name: string; color?: string }
  /** La personne pour qui l'agent ecrivait. */
  forUser?: AiChangeWho
  /** Ce que l'agent a fait (« passage remplacé »), une entree par ecriture. */
  summaries: string[]
  /** Pourquoi (le champ `why` des outils). */
  reasons: string[]
  count: number
  /** Caracteres ajoutes, et supprimes. */
  inserted: number
  deleted: number
  undone?: { at: string; by: AiChangeWho }
}

/** Ou sont aujourd'hui les traces d'un point (positions dans le texte du moment). */
export interface AiChangeRanges {
  /** Le texte qu'il a ajoute, encore present. */
  inserted: { from: number; to: number }[]
  /** Ce qu'il a supprime, et ou c'etait. */
  deleted: { at: number; text: string }[]
}

/** Ce que l'appli dit d'une ecriture d'agent qu'elle fait ici (beginAiChange). */
export interface AiChangeMetaInput {
  agent: { id: string; name: string; color?: string }
  forUser?: AiChangeWho
  summary?: string
  reason?: string
}

/** Une ecriture d'agent en cours : `capture` entoure chaque modification du texte, `commit` range le point. */
export interface AiChangeRecording {
  capture<T>(fn: () => T): T
  /** Range le point (rien si rien n'a change). Rend son id. */
  commit(): string | null
}

export interface ICRDT {
  onLocalOp(cb: (op: Uint8Array) => void): () => void
  applyRemoteOp(op: Uint8Array): void
  getSnapshot(): Uint8Array

  encodeLocalPresence(changedClients: number[]): Uint8Array
  applyRemotePresence(bytes: Uint8Array): void
  getRemoteCursorPositions(): number[]
  onLocalPresenceChanged(cb: (bytes: Uint8Array, changedClients: number[]) => void): () => void

  onTextChange(cb: (text: ICollaborativeText, version?: CrdtVersion) => void): () => void

  getVersion(): CrdtVersion

  /**
   * Le texte du document avec des positions qui suivent les modifications
   * (ancres de la revision). Absent : pas de texte (document non textuel).
   */
  collaborativeText?(): ICollaborativeText

  /** Le texte du document, modifiable (contrat ISharedText). */
  sharedText?(): import('./sharedText').ISharedText

  /** Les agents IA presents dans la note (recus des autres, ou poses ici). */
  agentPeers?(): AgentPeer[]
  /** Appele quand un agent arrive, bouge ou part. */
  onAgentPeersChange?(cb: () => void): () => void
  /** Montre un agent qui tourne ici, chez soi et chez les autres (activity null : il part). */
  setAgentPresence?(p: AgentPresenceInput): void

  /** Les interventions de l'IA dans la note, compactees comme a l'affichage, la plus recente d'abord. */
  aiChanges?(): AiChangeInfo[]
  /**
   * Appele quand des points arrivent ou changent (ici ou chez un autre).
   * `added` : les points ranges qui viennent d'apparaitre (pour les montrer).
   */
  onAiChangesChange?(cb: (added: string[]) => void): () => void
  /** Ou sont aujourd'hui les traces de ces points ranges (les `parts` d'un point montre). */
  aiChangeRanges?(parts: readonly string[]): AiChangeRanges
  /** Annule ces points ranges, en une modification de la personne `by`. */
  undoAiChange?(parts: readonly string[], by: AiChangeWho): { ok: boolean; partial: boolean }
  /** L'appli ecrit pour un agent : ce qu'elle change dans `capture` devient un point. */
  beginAiChange?(meta: AiChangeMetaInput): AiChangeRecording

  dispose(): void
}
