// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Les onglets ouverts, retenus sur ce poste : par compte et par vault. Une
// page rechargee rouvre le dernier vault et ses notes ; revenir sur un vault
// rouvre celles qu'on y avait laissees. On retient les identifiants des
// documents, pas leurs chemins : une note renommee entre-temps se rouvre.

export interface SavedTabs {
  /** Documents ouverts, dans l'ordre des onglets. */
  ids: string[]
  /** L'onglet actif. */
  active?: string
}

const TABS = 'savoire-open-tabs'
const LAST_VAULT = 'savoire-last-vault'
/** Au-dela, les plus anciens tombent : une session ne rouvre pas cent notes. */
const MAX_TABS = 30

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function storage(): Store | null {
  try { return globalThis.localStorage ?? null } catch { return null }
}

export function saveTabs(userId: string, vaultId: string, tabs: SavedTabs, store: Store | null = storage()): void {
  if (!store || !userId || !vaultId) return
  const ids = [...new Set(tabs.ids)].slice(-MAX_TABS)
  try {
    if (ids.length === 0) store.removeItem(`${TABS}:${userId}:${vaultId}`)
    else store.setItem(`${TABS}:${userId}:${vaultId}`, JSON.stringify({ ids, active: tabs.active && ids.includes(tabs.active) ? tabs.active : undefined }))
  } catch { /* stockage plein ou interdit : on ne retient rien */ }
}

export function loadTabs(userId: string, vaultId: string, store: Store | null = storage()): SavedTabs {
  try {
    const raw = store?.getItem(`${TABS}:${userId}:${vaultId}`)
    const v = raw ? JSON.parse(raw) as Partial<SavedTabs> : null
    const ids = Array.isArray(v?.ids) ? v.ids.filter((x): x is string => typeof x === 'string') : []
    return { ids, active: typeof v?.active === 'string' && ids.includes(v.active) ? v.active : undefined }
  } catch {
    return { ids: [] }
  }
}

/** Le vault ouvert en dernier par ce compte, rouvert au rechargement. */
export function rememberLastVault(userId: string, vaultId: string | null, store: Store | null = storage()): void {
  if (!store || !userId) return
  try {
    if (vaultId) store.setItem(`${LAST_VAULT}:${userId}`, vaultId)
    else store.removeItem(`${LAST_VAULT}:${userId}`)
  } catch { /* rien */ }
}

export function lastVault(userId: string, store: Store | null = storage()): string | null {
  try { return store?.getItem(`${LAST_VAULT}:${userId}`) ?? null } catch { return null }
}
