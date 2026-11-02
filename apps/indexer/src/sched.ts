// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le « creneau » SQLite d'un fil d'execution. node:sqlite est synchrone :
// une seule tache SQLite a la fois par fil, de toute facon. Le creneau
// choisit LAQUELLE passe ensuite :
//   0. appels interactifs (requetes des clients) ;
//   1. mises a jour au fil de l'eau (notes modifiees) ;
//   2. constructions initiales (bridees).
// Les lectures reseau (backend) se font hors du creneau : elles ne bloquent
// personne.
//
// Contre la famine : une tache de priorite basse qui attend depuis trop
// longtemps (AGING_MS) passe devant, au plus une fois sur AGED_EVERY.

export const INTERACTIVE = 0
export const LIVE = 1
export const BUILD = 2
export type Priority = typeof INTERACTIVE | typeof LIVE | typeof BUILD

export const PRIORITY_NAMES = ['interactive', 'live', 'build'] as const

const AGING_MS = [Infinity, 300, 2000]
const AGED_EVERY = 3

interface Waiter {
  at: number
  start: () => void
  cancel: (reason: unknown) => void
}

export class SlotAbortedError extends Error {
  constructor() {
    super('tache annulee avant son tour')
    this.name = 'SlotAbortedError'
  }
}

export class PrioritySlot {
  private busy = false
  private readonly queues: Waiter[][] = [[], [], []]
  private sinceAged = 0
  /** Temps passe dans le creneau, par priorite (ms). */
  readonly busyMs = [0, 0, 0]
  /** Taches executees, par priorite. */
  readonly done = [0, 0, 0]

  depth(priority: Priority): number {
    return this.queues[priority]!.length
  }

  get running(): boolean {
    return this.busy
  }

  /**
   * Execute fn quand vient son tour. Annulee (SlotAbortedError) si le signal
   * part avant ; une fois lancee, elle va a son terme (SQLite synchrone).
   */
  run<T>(priority: Priority, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) { reject(new SlotAbortedError()); return }
      const waiter: Waiter = {
        at: Date.now(),
        start: () => {
          signal?.removeEventListener('abort', onAbort)
          const t0 = performance.now()
          let p: Promise<T>
          try {
            p = fn()
          } catch (err) {
            p = Promise.reject(err)
          }
          p.then(resolve, reject).finally(() => {
            this.busyMs[priority] += performance.now() - t0
            this.done[priority]++
            this.busy = false
            this.next()
          })
        },
        cancel: reject,
      }
      const onAbort = () => {
        const q = this.queues[priority]!
        const i = q.indexOf(waiter)
        if (i >= 0) { q.splice(i, 1); reject(new SlotAbortedError()) }
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.queues[priority]!.push(waiter)
      if (!this.busy) this.next()
    })
  }

  /** Rejette toutes les taches en attente (arret). */
  cancelAll(reason: unknown): void {
    for (const q of this.queues) for (const w of q.splice(0)) w.cancel(reason)
  }

  private next(): void {
    if (this.busy) return
    const w = this.pick()
    if (!w) return
    this.busy = true
    w.start()
  }

  private pick(): Waiter | undefined {
    const now = Date.now()
    if (this.sinceAged >= AGED_EVERY) {
      for (const p of [LIVE, BUILD]) {
        const head = this.queues[p]![0]
        if (head && now - head.at > AGING_MS[p]!) {
          this.sinceAged = 0
          return this.queues[p]!.shift()
        }
      }
    }
    for (const q of this.queues) {
      if (q.length) {
        this.sinceAged++
        return q.shift()
      }
    }
    return undefined
  }
}
