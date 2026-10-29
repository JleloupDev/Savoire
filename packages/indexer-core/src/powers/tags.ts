// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Pouvoir `tags` : les tags du vault (frontmatter et #tags du texte, hors
// code), et les notes d'un tag. Casse ignoree, comme Obsidian : #Projet et
// #projet sont le meme tag. Tags imbriques « a/b » : la liste les donne tels
// quels ; les notes de « a » comprennent celles de « a/b ».
import { sql } from '../driver'
import type { SqlStatement } from '../driver'
import { invalid } from '../errors'
import type { IndexPower, PowerContext } from '../power'
import { method } from '../power'
import { asObject, optInt, optString, reqString } from '../validate'

/** « a/b » -> bornes [« a/ », « a0 ») : toutes les cles qui commencent par « a/ ». */
function childRange(key: string): [string, string] {
  return [key + '/', key + '0']
}

function cleanTag(t: string): string {
  return t.trim().replace(/^#/, '').replace(/^\/+|\/+$/g, '').toLowerCase()
}

async function list(ctx: PowerContext, p: { prefix?: string; limit: number }) {
  const where = p.prefix ? 'WHERE tag_key = ? OR (tag_key >= ? AND tag_key < ?)' : ''
  const params = p.prefix ? [p.prefix, ...childRange(p.prefix)] : []
  const rows = await ctx.driver.all<{ tag: string; c: number }>(
    `SELECT min(tag) AS tag, count(*) AS c FROM tags ${where} GROUP BY tag_key ORDER BY c DESC, tag_key LIMIT ?`,
    [...params, p.limit])
  return { items: rows.map(r => ({ tag: r.tag, count: Number(r.c) })) }
}

async function notes(ctx: PowerContext, p: { tag: string; limit: number }) {
  const rows = await ctx.driver.all<{ id: string; path: string; title: string }>(
    `SELECT d.id AS id, d.path AS path, d.title AS title FROM docs d
     WHERE d.n IN (SELECT doc FROM tags WHERE tag_key = ? OR (tag_key >= ? AND tag_key < ?))
     ORDER BY d.path_fold, d.id LIMIT ?`, [p.tag, ...childRange(p.tag), p.limit])
  return { items: rows }
}

export const tagsPower: IndexPower = {
  name: 'tags',
  version: 1,
  tables: ['tags'],
  schema: [
    `CREATE TABLE IF NOT EXISTS tags (
      doc INTEGER NOT NULL,
      tag_key TEXT NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY (doc, tag_key)
    ) WITHOUT ROWID`,
    'CREATE INDEX IF NOT EXISTS tags_key ON tags (tag_key)',
  ],
  write(_ctx, doc, note) {
    const seen = new Set<string>()
    const out: SqlStatement[] = []
    for (const tag of note.tags) {
      const key = tag.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(sql('INSERT INTO tags (doc, tag_key, tag) VALUES (?, ?, ?)', doc.n, key, tag))
    }
    return out
  },
  remove: (_ctx, doc) => [sql('DELETE FROM tags WHERE doc = ?', doc.n)],
  methods: {
    list: method({
      parse(v: unknown) {
        const p = asObject(v)
        const prefix = optString(p, 'prefix', 256)
        return { ...(prefix ? { prefix: cleanTag(prefix) } : {}), limit: optInt(p, 'limit', 1, 10_000, 1000) }
      },
      run: (ctx, p) => list(ctx, p),
    }),
    notes: method({
      parse(v: unknown) {
        const p = asObject(v)
        const tag = cleanTag(reqString(p, 'tag', 256))
        if (!tag) throw invalid('tag : obligatoire.')
        return { tag, limit: optInt(p, 'limit', 1, 5000, 500) }
      },
      run: (ctx, p) => notes(ctx, p),
    }),
  },
}
