// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Pouvoir `links` : retroliens, liens sortants, liens non resolus, graphe.
//
// Resolution facon Obsidian, faite en SQL dans la transaction de la note :
//  1. chemin exact (« Dossier/Note », avec ou sans extension) ; d'abord
//     relatif au dossier de la note pour un lien « ./ », « ../ » ou Markdown,
//     puis depuis la racine du vault ;
//  2. sinon par nom de fichier (sans extension, casse ignoree) ; un lien
//     « a/b » exige un chemin qui finit par « /a/b » ; en cas d'ambiguite, le
//     .md d'abord, puis le plus court chemin, puis l'ordre alphabetique ;
//  3. sinon par alias (frontmatter `aliases`).
// Un lien garde sa cible resolue (`dst`). Quand une note arrive, change de
// nom ou d'alias, ou disparait, seuls les liens concernes (meme nom, meme
// alias, ou qui pointaient vers elle) sont resolus a nouveau.
import { sql } from '../driver'
import type { SqlStatement, SqlValue } from '../driver'
import { invalid } from '../errors'
import type { LinkRef } from '../extract/markdown'
import { docKeys, folderOf, nameOf, normalizePath, resolveFrom } from '../paths'
import type { DocRef, IndexPower, PowerContext } from '../power'
import { method } from '../power'
import { asObject, optInt, optString, reqString } from '../validate'
import { notesFilter } from './query'

/**
 * Cles d'un lien vu depuis la note `sourcePath` (minuscules) :
 *  - t : le chemin tel qu'ecrit, depuis la racine (« ./ » et « ../ » de tete
 *    retires) ; sert au chemin exact, au nom, au suffixe « a/b », aux alias ;
 *  - rel : le chemin relatif au dossier de la note (liens « ./ », « ../ »,
 *    et liens Markdown), essaye en premier ;
 *  - n : le nom de fichier vise.
 * null : lien vide.
 */
export function linkKeys(raw: string, kind: LinkRef['kind'], sourcePath: string): { t: string; rel: string | null; n: string } | null {
  const target = raw.trim().replace(/\\/g, '/')
  if (!target) return null
  const relative = target.startsWith('./') || target.startsWith('../')
  const abs = normalizePath(target.replace(/^(\.\.?\/)+/, ''))
  if (!abs) return null
  const rel = relative || (kind === 'markdown' && !target.startsWith('/')) ? resolveFrom(folderOf(sourcePath), target) : null
  const t = abs.toLowerCase()
  const r = rel?.toLowerCase()
  return { t, rel: r && r !== t ? r : null, n: nameOf(t) }
}

/** Candidats d'un lien : notes de meme nom (le tri ne peut pas citer `links` : SQLite le refuse). */
const SAME_NAME = 'd.base IS NULL AND (d.name_key = links.n_key OR d.name_full_key = links.n_key)'
const BEST = "ORDER BY (d.ext = 'md') DESC, length(d.path), d.path LIMIT 1"

/**
 * Resout a nouveau les liens choisis par `scope` (condition sur `links`).
 * Chaque etape n'est evaluee que si la precedente ne trouve rien.
 */
function resolveWhere(scope: string, params: SqlValue[]): SqlStatement {
  return {
    sql: `UPDATE links SET dst = coalesce(
      (SELECT d.n FROM docs d WHERE ${SAME_NAME} AND links.t_rel IS NOT NULL
        AND (d.full_key = links.t_rel OR d.path_key = links.t_rel) ${BEST}),
      (SELECT d.n FROM docs d WHERE ${SAME_NAME}
        AND (d.full_key = links.t_key OR d.path_key = links.t_key) ${BEST}),
      (SELECT d.n FROM docs d WHERE ${SAME_NAME}
        AND (instr(links.t_key, '/') = 0
          OR substr(d.full_key, -length(links.t_key) - 1) = '/' || links.t_key
          OR substr(d.path_key, -length(links.t_key) - 1) = '/' || links.t_key) ${BEST}),
      (SELECT a.doc FROM aliases a JOIN docs d ON d.n = a.doc
        WHERE a.alias_key = links.t_key AND d.base IS NULL ORDER BY length(d.path), d.path LIMIT 1)
    ) WHERE ${scope}`,
    params,
  }
}

/** Liens a revoir quand le document `n` (de ce chemin et de ces alias) change. */
function resolveAround(n: number, path: string, aliasKeys: string[]): SqlStatement {
  const k = docKeys(path)
  const aliases = aliasKeys.length ? ` OR t_key IN (${aliasKeys.map(() => '?').join(', ')})` : ''
  return resolveWhere(`src = ? OR dst = ? OR n_key IN (?, ?)${aliases}`, [n, n, k.nameKey, k.nameFullKey, ...aliasKeys])
}

const INSERT_LINK = `INSERT INTO links (src, pos, raw, kind, t_key, t_rel, n_key, subpath, embed, dst)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`

function linkRows(doc: DocRef, links: readonly LinkRef[]): SqlStatement[] {
  const out: SqlStatement[] = []
  links.forEach((l, pos) => {
    const k = linkKeys(l.target, l.kind, doc.path)
    if (!k) return
    out.push(sql(INSERT_LINK, doc.n, pos, l.target, l.kind, k.t, k.rel, k.n, l.subpath ?? null, l.embed ? 1 : 0))
  })
  return out
}

// ── Methodes ─────────────────────────────────────────────────────────────

interface DocItem { id: string; path: string; title: string }

async function backlinks(ctx: PowerContext, p: { id: string; limit: number }) {
  const rows = await ctx.driver.all<{ id: string; path: string; title: string; c: number }>(
    `SELECT s.id AS id, s.path AS path, s.title AS title, count(*) AS c
     FROM docs t JOIN links l ON l.dst = t.n JOIN docs s ON s.n = l.src
     WHERE t.id = ? AND l.src <> l.dst
     GROUP BY s.n ORDER BY s.path_fold, s.id LIMIT ?`, [p.id, p.limit])
  return { items: rows.map(r => ({ id: r.id, path: r.path, title: r.title, count: Number(r.c) })) }
}

async function outgoing(ctx: PowerContext, p: { id: string }) {
  const resolved = await ctx.driver.all<DocItem & { pos: number }>(
    `SELECT t.id AS id, t.path AS path, t.title AS title, min(l.pos) AS pos
     FROM docs s JOIN links l ON l.src = s.n JOIN docs t ON t.n = l.dst
     WHERE s.id = ? GROUP BY t.n ORDER BY pos`, [p.id])
  const unresolved = await ctx.driver.all<{ target: string; pos: number }>(
    `SELECT l.raw AS target, min(l.pos) AS pos
     FROM docs s JOIN links l ON l.src = s.n
     WHERE s.id = ? AND l.dst IS NULL GROUP BY l.t_key ORDER BY pos`, [p.id])
  return {
    resolved: resolved.map(r => ({ id: r.id, path: r.path, title: r.title })),
    unresolved: unresolved.map(r => ({ target: r.target })),
  }
}

const MAX_SOURCES = 50

async function unresolvedLinks(ctx: PowerContext, p: { limit: number }) {
  const groups = await ctx.driver.all<{ k: string; target: string; c: number }>(
    `SELECT l.t_key AS k, min(l.raw) AS target, count(*) AS c FROM links l
     WHERE l.dst IS NULL GROUP BY l.t_key ORDER BY c DESC, l.t_key LIMIT ?`, [p.limit])
  const sources = new Map<string, string[]>()
  if (groups.length) {
    const rows = await ctx.driver.all<{ k: string; id: string }>(
      `SELECT l.t_key AS k, s.id AS id FROM links l JOIN docs s ON s.n = l.src
       WHERE l.dst IS NULL AND l.t_key IN (SELECT value FROM json_each(?))
       GROUP BY l.t_key, s.id ORDER BY l.t_key, s.id`, [JSON.stringify(groups.map(g => g.k))])
    for (const r of rows) {
      const list = sources.get(r.k) ?? []
      if (list.length < MAX_SOURCES) list.push(r.id)
      sources.set(r.k, list)
    }
  }
  return { items: groups.map(g => ({ target: g.target, count: Number(g.c), sources: sources.get(g.k) ?? [] })) }
}

const MAX_EDGES = 100_000

async function graph(ctx: PowerContext, p: { folder?: string; limit: number }) {
  const scope = notesFilter(p.folder, undefined)
  // Les notes les plus reliees d'abord, si elles sont trop nombreuses.
  const nodes = await ctx.driver.all<{ n: number } & DocItem>(
    `SELECT d.n AS n, d.id AS id, d.path AS path, d.title AS title,
       (SELECT count(*) FROM links l WHERE l.src = d.n AND l.dst IS NOT NULL AND l.dst <> d.n)
       + (SELECT count(*) FROM links l WHERE l.dst = d.n AND l.src <> d.n) AS deg
     FROM docs d WHERE ${scope.sql} ORDER BY deg DESC, d.path_fold, d.id LIMIT ?`, [...scope.params, p.limit])
  const ids = JSON.stringify(nodes.map(x => Number(x.n)))
  const edges = nodes.length
    ? await ctx.driver.all<{ a: string; b: string }>(
      `WITH k(n) AS (SELECT value FROM json_each(?))
       SELECT DISTINCT s.id AS a, t.id AS b FROM links l
       JOIN docs s ON s.n = l.src JOIN docs t ON t.n = l.dst
       WHERE l.src IN (SELECT n FROM k) AND l.dst IN (SELECT n FROM k) AND l.src <> l.dst
       LIMIT ?`, [ids, MAX_EDGES])
    : []
  return {
    nodes: nodes.map(x => ({ id: x.id, path: x.path, title: x.title })),
    edges: edges.map(e => ({ from: e.a, to: e.b })),
  }
}

// ── Ecriture ─────────────────────────────────────────────────────────────

export const linksPower: IndexPower = {
  name: 'links',
  version: 1,
  tables: ['links', 'aliases'],
  schema: [
    `CREATE TABLE IF NOT EXISTS links (
      src INTEGER NOT NULL,
      pos INTEGER NOT NULL,
      raw TEXT NOT NULL,
      kind TEXT NOT NULL,
      t_key TEXT NOT NULL,
      t_rel TEXT,
      n_key TEXT NOT NULL,
      subpath TEXT,
      embed INTEGER NOT NULL,
      dst INTEGER,
      PRIMARY KEY (src, pos)
    )`,
    'CREATE INDEX IF NOT EXISTS links_dst ON links (dst)',
    'CREATE INDEX IF NOT EXISTS links_n ON links (n_key)',
    'CREATE INDEX IF NOT EXISTS links_t ON links (t_key)',
    `CREATE TABLE IF NOT EXISTS aliases (
      doc INTEGER NOT NULL,
      alias_key TEXT NOT NULL,
      alias TEXT NOT NULL,
      PRIMARY KEY (doc, alias_key)
    ) WITHOUT ROWID`,
    'CREATE INDEX IF NOT EXISTS aliases_key ON aliases (alias_key)',
  ],

  write(_ctx, doc, note) {
    if (note.base !== undefined) return []
    const aliasKeys: string[] = []
    const out: SqlStatement[] = []
    for (const a of note.aliases) {
      const key = a.toLowerCase()
      if (aliasKeys.includes(key)) continue
      aliasKeys.push(key)
      out.push(sql('INSERT INTO aliases (doc, alias_key, alias) VALUES (?, ?, ?)', doc.n, key, a))
    }
    out.push(...linkRows(doc, note.links))
    out.push(resolveAround(doc.n, doc.path, aliasKeys))
    return out
  },

  remove: (_ctx, doc) => [
    sql('DELETE FROM links WHERE src = ?', doc.n),
    sql('DELETE FROM aliases WHERE doc = ?', doc.n),
  ],

  afterRemove: (_ctx, doc) => [resolveWhere('dst = ?', [doc.n])],

  async move(ctx, doc) {
    const rows = await ctx.driver.all<{ pos: number; raw: string; kind: LinkRef['kind'] }>(
      'SELECT pos, raw, kind FROM links WHERE src = ?', [doc.n])
    const out: SqlStatement[] = []
    for (const r of rows) {
      const k = linkKeys(r.raw, r.kind, doc.path)
      if (!k) out.push(sql('DELETE FROM links WHERE src = ? AND pos = ?', doc.n, r.pos))
      else out.push(sql('UPDATE links SET t_key = ?, t_rel = ?, n_key = ? WHERE src = ? AND pos = ?', k.t, k.rel, k.n, doc.n, r.pos))
    }
    const aliases = await ctx.driver.all<{ k: string }>('SELECT alias_key AS k FROM aliases WHERE doc = ?', [doc.n])
    out.push(resolveAround(doc.n, doc.path, aliases.map(a => a.k)))
    return out
  },

  methods: {
    backlinks: method({
      parse(v: unknown) {
        const p = asObject(v)
        return { id: reqString(p, 'id', 256), limit: optInt(p, 'limit', 1, 10_000, 1000) }
      },
      run: (ctx, p) => backlinks(ctx, p),
    }),
    outgoing: method({
      parse(v: unknown) {
        return { id: reqString(asObject(v), 'id', 256) }
      },
      run: (ctx, p) => outgoing(ctx, p),
    }),
    unresolved: method({
      parse(v: unknown) {
        return { limit: optInt(asObject(v), 'limit', 1, 5000, 200) }
      },
      run: (ctx, p) => unresolvedLinks(ctx, p),
    }),
    graph: method({
      parse(v: unknown) {
        const p = asObject(v)
        const folder = optString(p, 'folder', 1024)
        if (folder !== undefined && folder.includes('\0')) throw invalid('folder invalide.')
        return { ...(folder ? { folder } : {}), limit: optInt(p, 'limit', 1, 20_000, 2000) }
      },
      run: (ctx, p) => graph(ctx, p),
    }),
  },
}
