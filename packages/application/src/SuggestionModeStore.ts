// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le mode suggestion, retenu par le compte : un canal d'index du vault
// (« review-mode », a cote des propositions dans « review »), une entree par
// compte. Il suit donc la personne sur tous ses appareils, en direct, et
// reste propre a chaque vault (suggestion dans le vault d'equipe, ecriture
// directe dans le sien). Personnel : les autres membres ne s'en servent pas.
import type { IVaultSyncSession } from './contracts'
import type { IIndexChannel } from '@savoire/plugin-api'

export interface SuggestionModeEntry {
  on: boolean
  /** Date du changement (ISO). */
  at: string
}

const isEntry = (v: unknown): v is SuggestionModeEntry =>
  !!v && typeof (v as SuggestionModeEntry).on === 'boolean'

export class SuggestionModeStore {
  private readonly channel: IIndexChannel

  constructor(session: Pick<IVaultSyncSession, 'openSharedMap'>, private readonly userId: string, private readonly now: () => Date = () => new Date()) {
    this.channel = session.openSharedMap('review-mode')
  }

  /** Le mode de ce compte dans ce vault (eteint par defaut). */
  get(): boolean {
    const v = this.channel.getAll().find(e => e.id === this.userId)?.value
    return isEntry(v) ? v.on : false
  }

  set(on: boolean): void {
    if (on === this.get()) return
    this.channel.set(this.userId, { on, at: this.now().toISOString() } satisfies SuggestionModeEntry)
  }

  /** Le mode de ce compte change (ici ou sur un autre appareil). */
  onChange(cb: (on: boolean) => void): () => void {
    let last = this.get()
    return this.channel.onChange(ids => {
      if (!ids.includes(this.userId)) return
      const on = this.get()
      if (on !== last) { last = on; cb(on) }
    })
  }
}
