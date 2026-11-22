// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Pouvoir `blocks` : les blocs de chaque note (paragraphes, listes, titres...),
// avec leur place, leur empreinte et leur identifiant « ^id ». Voir
// plugin-api/noteBlocks.ts pour le decoupage.
//
// Ce qu'il rend possible :
//  - list    : les blocs d'une note (lien [[note#^id]], extrait, plan) ;
//  - find    : les notes ou se trouve un bloc de cette empreinte ;
//  - shared  : les blocs d'une note que l'on retrouve a l'identique dans
//              d'autres notes (copier-coller, passage deja ecrit ailleurs).
//
// Le frontmatter n'est pas range ; un bloc garde un extrait de son texte
// (PREVIEW caracteres), pas tout son texte : le texte complet reste dans
// `search`.
import { sql } from '../driver'
import type { SqlStatement } from '../driver'
import { invalid } from '../errors'
import type { IndexPower, PowerContext } from '../power'
import { method } from '../power'
import { asObject, optInt, reqString } from '../validate'

const PREVIEW = 200
/** Un bloc plus court ne compte pas comme passage partage (« Oui. », « --- »). */
const SHARED_MIN_LENGTH = 40
const SHARED_KINDS = "('paragraph', 'list', 'quote', 'callout', 'table')"

function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > PREVIEW ? `${flat.slice(0, PREVIEW - 1)}…` : flat
}

interface BlockRow {
  i: number
  kind: string
  start_at: number
  end_at: number
  hash: string
  bid: string | null
  section: string | null
  preview: string
}

/** Le document indexe ; null : inconnu (resultat vide, comme les autres pouvoirs). */
async function docOf(ctx: PowerContext, id: string): Promise<{ n: number; id: string; path: string } | null> {
  const rows = await ctx.driver.all<{ n: number; id: string; path: string }>('SELECT n, id, path FROM docs WHERE id = ?', [id])
  return rows[0] ?? null
}

async function list(ctx: PowerContext, p: { id: string; limit: number }) {
  const doc = await docOf(ctx, p.id)
  if (!doc) return { id: p.id, path: '', items: [] }
  const rows = await ctx.driver.all<BlockRow>(
    'SELECT i, kind, start_at, end_at, hash, bid, section, preview FROM blocks WHERE doc = ? ORDER BY i LIMIT ?', [doc.n, p.limit])
  return {
    id: doc.id, path: doc.path,
    items: rows.map(r => ({
      index: Number(r.i), kind: r.kind, from: Number(r.start_at), to: Number(r.end_at), hash: r.hash, preview: r.preview,
      ...(r.bid ? { blockId: r.bid } : {}),
      ...(r.section ? { section: r.section } : {}),
    })),
  }
}

async function find(ctx: PowerContext, p: { hash: string; limit: number }) {
  const rows = await ctx.driver.all<{ id: string; path: string; title: string; i: number; kind: string; preview: string; bid: string | null }>(
    `SELECT d.id AS id, d.path AS path, d.title AS title, b.i AS i, b.kind AS kind, b.preview AS preview, b.bid AS bid
     FROM blocks b JOIN docs d ON d.n = b.doc WHERE b.hash = ? ORDER BY d.path_fold, d.id, b.i LIMIT ?`, [p.hash, p.limit])
  return {
    items: rows.map(r => ({ id: r.id, path: r.path, title: r.title, index: Number(r.i), kind: r.kind, preview: r.preview, ...(r.bid ? { blockId: r.bid } : {}) })),
  }
}

async function shared(ctx: PowerContext, p: { id: string; limit: number }) {
  const doc = await docOf(ctx, p.id)
  if (!doc) return { id: p.id, path: '', items: [] }
  const rows = await ctx.driver.all<{ i: number; hash: string; id: string; path: string; title: string }>(
    `SELECT b.i AS i, b.hash AS hash, d.id AS id, d.path AS path, d.title AS title
     FROM blocks b JOIN blocks o ON o.hash = b.hash AND o.doc <> b.doc JOIN docs d ON d.n = o.doc
     WHERE b.doc = ? AND b.kind IN ${SHARED_KINDS} AND b.len >= ${SHARED_MIN_LENGTH}
     GROUP BY b.i, d.n ORDER BY b.i, d.path_fold LIMIT ?`, [doc.n, p.limit])
  const byBlock = new Map<number, { index: number; hash: string; others: { id: string; path: string; title: string }[] }>()
  for (const r of rows) {
    const i = Number(r.i)
    let entry = byBlock.get(i)
    if (!entry) { entry = { index: i, hash: r.hash, others: [] }; byBlock.set(i, entry) }
    entry.others.push({ id: r.id, path: r.path, title: r.title })
  }
  return { id: doc.id, path: doc.path, items: [...byBlock.values()] }
}

const HASH_RE = /^[0-9a-f]{16}$/

export const blocksPower: IndexPower = {
  name: 'blocks',
  version: 1,
  tables: ['blocks'],
  schema: [
    `CREATE TABLE IF NOT EXISTS blocks (
      doc INTEGER NOT NULL,
      i INTEGER NOT NULL,
      kind TEXT NOT NULL,
      start_at INTEGER NOT NULL,
      end_at INTEGER NOT NULL,
      len INTEGER NOT NULL,
      hash TEXT NOT NULL,
      bid TEXT,
      section TEXT,
      preview TEXT NOT NULL,
      PRIMARY KEY (doc, i)
    ) WITHOUT ROWID`,
    'CREATE INDEX IF NOT EXISTS blocks_hash ON blocks (hash)',
  ],
  write(_ctx, doc, note) {
    const out: SqlStatement[] = []
    for (const b of note.blocks ?? []) {
      if (b.kind === 'frontmatter') continue
      out.push(sql(
        'INSERT INTO blocks (doc, i, kind, start_at, end_at, len, hash, bid, section, preview) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        doc.n, b.index, b.kind, b.from, b.to, b.text.length, b.hash, b.blockId ?? null, b.section ?? null, preview(b.text)))
    }
    return out
  },
  remove: (_ctx, doc) => [sql('DELETE FROM blocks WHERE doc = ?', doc.n)],
  methods: {
    list: method({
      parse(v: unknown) {
        const p = asObject(v)
        return { id: reqString(p, 'id', 256), limit: optInt(p, 'limit', 1, 10_000, 2000) }
      },
      run: (ctx, p) => list(ctx, p),
    }),
    find: method({
      parse(v: unknown) {
        const p = asObject(v)
        const hash = reqString(p, 'hash', 16)
        if (!HASH_RE.test(hash)) throw invalid('hash : 16 caracteres hexadecimaux.')
        return { hash, limit: optInt(p, 'limit', 1, 500, 50) }
      },
      run: (ctx, p) => find(ctx, p),
    }),
    shared: method({
      parse(v: unknown) {
        const p = asObject(v)
        return { id: reqString(p, 'id', 256), limit: optInt(p, 'limit', 1, 2000, 500) }
      },
      run: (ctx, p) => shared(ctx, p),
    }),
  },
}
