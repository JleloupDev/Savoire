// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Pouvoir `index` : l'etat de l'index (construction, retard, taille).
// Sans table : il lit `docs` et la table de meta du noyau.
import type { IndexState } from '@savoire/plugin-api'
import type { IndexPower, PowerContext } from '../power'
import { method } from '../power'
import { asObject } from '../validate'

export interface IndexStatus extends IndexState {
  /** Derniere sequence du flux de changements traitee. */
  seq: number
  /** Notes indexees (lignes legeres de base non comprises). */
  docs: number
  /** Taille de la base, en octets. */
  bytes: number
}

export async function indexStatus(ctx: PowerContext): Promise<IndexStatus> {
  const [seq] = await ctx.driver.all<{ v: string }>("SELECT value AS v FROM meta WHERE key = 'seq'")
  const [docs] = await ctx.driver.all<{ c: number }>('SELECT count(*) AS c FROM docs WHERE base IS NULL')
  const [pages] = await ctx.driver.all<{ page_count: number }>('PRAGMA page_count')
  const [size] = await ctx.driver.all<{ page_size: number }>('PRAGMA page_size')
  return {
    ...ctx.state(),
    seq: Number(seq?.v ?? 0),
    docs: Number(docs?.c ?? 0),
    bytes: Number(pages?.page_count ?? 0) * Number(size?.page_size ?? 0),
  }
}

export const statusPower: IndexPower = {
  name: 'index',
  version: 1,
  methods: {
    status: method({
      parse: (v: unknown) => { asObject(v); return {} },
      run: ctx => indexStatus(ctx),
    }),
  },
}
