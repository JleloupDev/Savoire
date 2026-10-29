// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Ouvertures de documents comptees.
//
// openDocument est idempotent (le meme CRDT pour le meme document), mais
// closeDocument arrete la synchro tout de suite, pour tout le monde. Des que
// deux choses tiennent le meme document (un editeur et une base qui ecrit son
// frontmatter, deux onglets, un lot de lignes lu par l'index), la premiere
// qui le ferme le coupe sous les pieds de l'autre.
//
// withDocumentRefCount rend la meme session, ou chaque openDocument doit etre
// rendu par un closeDocument : le document ne se ferme qu'au dernier. Tout le
// reste passe tel quel a la session (meme objet dessous).
import type { IVaultSyncSession } from './contracts'

const COUNTS = Symbol('savoire.documentRefCounts')

type Counted = { [COUNTS]: Map<string, number> }

const wrapped = new WeakMap<object, IVaultSyncSession>()

export function withDocumentRefCount<T extends IVaultSyncSession>(session: T): T {
  if ((session as unknown as Partial<Counted>)[COUNTS]) return session
  const existing = wrapped.get(session)
  if (existing) return existing as T
  const counts = new Map<string, number>()
  const proxy = new Proxy(session, {
    get(target, prop) {
      if (prop === COUNTS) return counts
      if (prop === 'openDocument') {
        return (docId: string) => {
          const crdt = target.openDocument(docId)
          counts.set(docId, (counts.get(docId) ?? 0) + 1)
          return crdt
        }
      }
      if (prop === 'closeDocument') {
        return (docId: string) => {
          const n = (counts.get(docId) ?? 0) - 1
          if (n > 0) { counts.set(docId, n); return }
          counts.delete(docId)
          target.closeDocument(docId)
        }
      }
      const value = Reflect.get(target, prop, target) as unknown
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
    },
  })
  wrapped.set(session, proxy)
  return proxy
}

/** Nombre d'ouvertures en cours d'un document (0 : fermé), si la session les compte. */
export function documentOpenCount(session: IVaultSyncSession, docId: string): number | undefined {
  return (session as unknown as Partial<Counted>)[COUNTS]?.get(docId) ?? ((session as unknown as Partial<Counted>)[COUNTS] ? 0 : undefined)
}
