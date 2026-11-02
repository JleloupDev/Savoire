// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Lignes legeres des bases -> index local. Les lots sont ouverts par le
// fournisseur de requetes de l'appli (QueryEngineProvider), qui les lit deja
// pour son moteur en memoire : il passe ici ce qu'il lit (miroir).
//
// L'index local persiste (disque, OPFS) : une ligne supprimee pendant que
// l'appli etait fermee y serait encore. Quand un lot est lu en entier, ses
// lignes indexees absentes du lot sont donc retirees.
import { baseLotOf } from '@savoire/plugin-api'
import type { PropertyValue } from '@savoire/plugin-api'
import { makeRecord } from '../extract/note'
import type { ILocalIndex } from './LocalIndex'

/** Une ligne legere telle que le fournisseur la lit (LocalIndexedDoc). */
export interface RowDoc {
  id: string
  base?: string
  path: string
  title: string
  props: Record<string, PropertyValue>
}

export class BaseRowFeeder {
  private tail: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly index: ILocalIndex,
    private readonly onError: (err: unknown) => void = err => console.warn('[index local] lignes de base', err),
  ) {}

  /** Un lot lu en entier : toutes ses lignes. */
  lot(baseId: string, lot: number, lotCount: number, rows: readonly RowDoc[]): void {
    const docs = rows.map(r => ({ ...r, base: baseId }))
    this.enqueue(async () => {
      const present = new Set(docs.map(d => d.id))
      const stale = (await this.index.rowIds(baseId)).filter(id => !present.has(id) && baseLotOf(id, lotCount) === lot)
      await this.index.removeDocs(stale)
      if (docs.length) await this.index.applyRecords(docs.map(toRecord))
    })
  }

  /** Lignes changees ou supprimees d'un lot deja lu. */
  rows(upserts: readonly RowDoc[], removed: readonly string[]): void {
    const docs = upserts.filter(d => d.base !== undefined)
    this.enqueue(async () => {
      if (removed.length) await this.index.removeDocs(removed)
      if (docs.length) await this.index.applyRecords(docs.map(toRecord))
    })
  }

  /** Resolu quand tout ce qui a ete recu est ecrit. */
  whenIdle(): Promise<void> {
    return this.tail.then(() => undefined)
  }

  private enqueue(job: () => Promise<void>): void {
    this.tail = this.tail.then(job).catch(this.onError)
  }
}

function toRecord(d: RowDoc) {
  return makeRecord({ id: d.id, base: d.base, path: '', title: d.title, props: d.props })
}
