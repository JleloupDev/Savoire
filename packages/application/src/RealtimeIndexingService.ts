// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { IndexEngine } from '@savoire/domain-index'
import type { ITextChangeSource } from './ITextChangeSource'

// Pilote les contributeurs d'ANCRES a chaque changement de texte CRDT.
// Purement local : les ancres suivent des positions dans le texte de ce pair,
// elles ne traversent jamais le reseau. Les index partages, eux, passent par
// ContentIndexingService et ses canaux CRDT.
//
// Cycle de vie :
//   1. Construire avec la source et le moteur.
//   2. start() une fois le vault actif.
//   3. stop() a la desactivation.
export class RealtimeIndexingService {
  private unsubscribeText: (() => void) | null = null

  constructor(
    private readonly source: ITextChangeSource,
    private readonly engine: IndexEngine,
  ) {}

  start(): void {
    this.unsubscribeText = this.source.subscribe((docId, text) => {
      this.engine.onTextChange(text, docId)
    })
  }

  stop(): void {
    this.unsubscribeText?.()
    this.unsubscribeText = null
  }
}
