// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Ce que les IA ont deja lu (ADR-033), pour ne leur rendre que ce qui a change :
//  - les VERSIONS : jeton -> empreintes des blocs (read_note since: <jeton>) ;
//  - la MEMOIRE de chaque agent : pour chaque (agent, note), la version qu'il
//    connait (read_note since: "last").
//
// En memoire seulement, bornee : la plus anciennement servie part la premiere.
// Aucun texte n'y est garde, seulement des empreintes. Un jeton perdu n'est
// pas une erreur : l'outil le dit et rend le texte entier.
import type { ToolActor } from '@savoire/plugin-api'
import type { NoteSnapshot } from './noteRefs'

export interface AgentView {
  /** La note telle que l'agent la connait. */
  snapshot: NoteSnapshot
  /** Blocs « ^id » dont on lui a rendu le texte depuis (apres un refus d'ecriture) : id -> empreinte. */
  known: Map<string, string>
}

type Entry = { kind: 'version'; snapshot: NoteSnapshot } | { kind: 'view'; view: AgentView }

export class ReadMemory {
  private readonly entries = new Map<string, Entry>()
  private weight = 0

  /**
   * @param maxEntries nombre de versions et de memoires gardees ;
   * @param maxBlocks  nombre total d'empreintes de blocs gardees.
   */
  constructor(private readonly maxEntries = 600, private readonly maxBlocks = 200_000) {}

  get size(): number {
    return this.entries.size
  }

  private static weigh(e: Entry): number {
    return 1 + (e.kind === 'version' ? e.snapshot.blocks.length : e.view.snapshot.blocks.length)
  }

  private get(key: string): Entry | undefined {
    const e = this.entries.get(key)
    if (!e) return undefined
    // Servie : elle redevient la plus recente.
    this.entries.delete(key)
    this.entries.set(key, e)
    return e
  }

  private set(key: string, e: Entry): void {
    const prev = this.entries.get(key)
    if (prev) {
      this.weight -= ReadMemory.weigh(prev)
      this.entries.delete(key)
    }
    this.entries.set(key, e)
    this.weight += ReadMemory.weigh(e)
    for (const [k, old] of this.entries) {
      if (this.entries.size <= this.maxEntries && this.weight <= this.maxBlocks) break
      if (k === key) break // la derniere entree reste, meme tres grosse
      this.entries.delete(k)
      this.weight -= ReadMemory.weigh(old)
    }
  }

  /** Garde une version, sous son jeton. */
  remember(snapshot: NoteSnapshot): void {
    if (!snapshot.token) return
    this.set(`v\n${snapshot.docId}\n${snapshot.token}`, { kind: 'version', snapshot })
  }

  /** La version de ce jeton, pour cette note. Undefined : oubliee, ou inconnue. */
  version(docId: string, token: string): NoteSnapshot | undefined {
    if (!token.trim()) return undefined
    const e = this.get(`v\n${docId}\n${token.trim()}`)
    return e?.kind === 'version' ? e.snapshot : undefined
  }

  private static viewKey(actor: ToolActor, docId: string): string {
    // Un agent partage a une memoire par personne.
    return `a\n${actor.agentId}\n${actor.onBehalfOf?.userId ?? ''}\n${docId}`
  }

  /** La note telle que cet agent la connait. */
  view(actor: ToolActor, docId: string): AgentView | undefined {
    const e = this.get(ReadMemory.viewKey(actor, docId))
    return e?.kind === 'view' ? e.view : undefined
  }

  /**
   * Ce que l'agent connait maintenant. `keep` : garde ce qu'on lui a rendu
   * apres un refus (il n'a recu qu'une partie de la note).
   */
  setView(actor: ToolActor, snapshot: NoteSnapshot, keep = false): void {
    const key = ReadMemory.viewKey(actor, snapshot.docId)
    const prev = keep ? this.entries.get(key) : undefined
    this.set(key, { kind: 'view', view: { snapshot, known: prev?.kind === 'view' ? prev.view.known : new Map() } })
  }

  /** On vient de rendre a l'agent le texte d'un bloc « ^id » qui avait change. */
  acknowledge(actor: ToolActor, docId: string, blockId: string, hash: string): void {
    this.view(actor, docId)?.known.set(blockId, hash)
  }

  /** Les versions gardees de cette note (celle de l'agent d'abord), pour retrouver un bloc disparu. */
  versionsOf(actor: ToolActor, docId: string): NoteSnapshot[] {
    const out: NoteSnapshot[] = []
    const own = this.entries.get(ReadMemory.viewKey(actor, docId))
    if (own?.kind === 'view') out.push(own.view.snapshot)
    for (const e of this.entries.values()) if (e.kind === 'version' && e.snapshot.docId === docId) out.push(e.snapshot)
    return out
  }
}

/** La memoire de ce processus : l'appli (un onglet), ou le pair (tous ses vaults). */
export const sharedReadMemory = new ReadMemory()
