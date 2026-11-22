// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Regles d'acces de l'appelant (ADR-033) : le serveur les joint a chaque appel
// (caller.access, voir access::peer_rules cote Rust). Le pair les applique a
// ses resultats : une note interdite a la personne n'existe pas pour elle, ni
// pour l'agent qui agit en son nom.
//
// Meme regle que for_levels du serveur : la note, puis ses dossiers du plus
// profond a la racine ; a chaque niveau, un droit donne a la personne gagne
// (« none » : aucun acces), sinon un niveau qui n'herite plus ferme ; a la fin,
// le droit de base dans le vault.
//
// Limites connues : les compteurs (total, nombre de notes par tag) ne sont pas
// corriges.
//
// Une ligne legere de base (sans chemin ni note a elle) suit les droits de SA
// base : le document .base et ses dossiers. L'appelant donne la base (id et
// chemin) ; sans elle, une ligne legere n'est pas montree.

export interface AccessRules {
  base: 'admin' | 'write' | 'read' | 'none' | string
  rules?: { folder?: string; doc?: string; permission: string }[]
  closed?: { folder?: string; doc?: string }[]
}

export function parseAccess(v: unknown): AccessRules | undefined {
  if (!v || typeof v !== 'object' || typeof (v as AccessRules).base !== 'string') return undefined
  return v as AccessRules
}

/** Faut-il filtrer ? (proprietaire, administrateur : non) */
export function restricts(a: AccessRules | undefined): a is AccessRules {
  return !!a && a.base !== 'admin'
}

function folderOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

/** Un annexe (« id~texte ») suit son document. */
function docOf(id: string): string {
  const i = id.indexOf('~')
  return i < 0 ? id : id.slice(0, i)
}

export function canRead(a: AccessRules | undefined, id: string, path: string): boolean {
  if (!restricts(a)) return true
  const doc = docOf(id)
  const levels: ({ doc: string } | { folder: string })[] = [{ doc }]
  for (let f = folderOf(path); f; f = folderOf(f)) levels.push({ folder: f })
  for (const level of levels) {
    const isDoc = 'doc' in level
    const rule = a.rules?.find(r => (isDoc ? r.doc === level.doc : r.folder === (level as { folder: string }).folder))
    if (rule) return rule.permission !== 'none'
    if (a.closed?.some(c => (isDoc ? c.doc === level.doc : c.folder === (level as { folder: string }).folder))) return false
  }
  return a.base !== 'none'
}

type Ref = { id?: unknown; path?: unknown }
const visible = (a: AccessRules, r: Ref): boolean => typeof r?.id !== 'string' || canRead(a, r.id, typeof r.path === 'string' ? r.path : '')

/**
 * Le resultat d'un pouvoir, sans ce que la personne ne peut pas voir.
 * Rejette (null) un document lu qui lui est interdit.
 */
export function filterResult(
  a: AccessRules | undefined, capability: string, method: string, result: unknown,
  opts: { base?: { id: string; path: string } } = {},
): unknown | null {
  if (!restricts(a) || !result || typeof result !== 'object') return result
  const r = result as Record<string, unknown>
  const keep = (k: string) => { if (Array.isArray(r[k])) r[k] = (r[k] as Ref[]).filter(x => visible(a, x)) }
  if (capability === 'documents' && (method === 'read' || method === 'path')) return visible(a, r) ? r : null
  if (capability === 'search') keep('hits')
  if (capability === 'query' && Array.isArray(r.rows)) {
    const base = opts.base
    const baseOk = !!base && canRead(a, base.id, base.path)
    r.rows = (r.rows as Ref[]).filter(row => (row?.path === '' ? baseOk : visible(a, row)))
  }
  if (capability === 'links') {
    keep('items'); keep('resolved')
    if (Array.isArray(r.nodes)) {
      keep('nodes')
      const ids = new Set((r.nodes as Ref[]).map(n => n.id))
      if (Array.isArray(r.edges)) r.edges = (r.edges as { from: unknown; to: unknown }[]).filter(e => ids.has(e.from) && ids.has(e.to))
    }
    // Liens casses : les notes qui les contiennent, sans leur chemin (droits de la note et de la racine).
    if (Array.isArray(r.items)) {
      for (const it of r.items as { sources?: unknown }[]) {
        if (Array.isArray(it.sources)) it.sources = (it.sources as unknown[]).filter(s => typeof s !== 'string' || canRead(a, s, ''))
      }
    }
  }
  if (capability === 'tags') keep('items')
  if (capability === 'blocks') {
    // Les blocs d'une note : la note elle-meme doit etre permise.
    if ((method === 'list' || method === 'shared') && !visible(a, r)) return null
    if (method === 'find') keep('items')
    if (method === 'shared' && Array.isArray(r.items)) {
      r.items = (r.items as { others?: Ref[] }[])
        .map(it => ({ ...it, others: Array.isArray(it.others) ? it.others.filter(o => visible(a, o)) : [] }))
        .filter(it => it.others.length > 0)
    }
  }
  return r
}

/** La base d'une requete (`from.base`), s'il y en a une. */
export function baseOfQuery(params: unknown): string | undefined {
  const b = (params as { from?: { base?: unknown } } | null)?.from?.base
  return typeof b === 'string' && b ? b : undefined
}
