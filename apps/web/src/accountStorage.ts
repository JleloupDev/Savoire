// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Ou l'app garde les comptes connectes (jeton de renouvellement compris).
//
// Navigateur : sessionStorage, comme avant (la session tombe avec l'onglet).
// Version bureau : la session du serveur choisi, gardee cote Rust pour
// survivre au redemarrage (voir serverConnection.ts). sessionStorage reste
// tenu a jour : d'anciens morceaux le lisent encore (plugin-module).

import type { AccountEntry } from './types'

export const ACCOUNTS_KEY = 'vault_accounts'

export interface AccountStorage {
  load(): AccountEntry[]
  save(accounts: AccountEntry[]): void
}

export function parseAccounts(raw: string | null | undefined): AccountEntry[] {
  if (!raw) return []
  try {
    const value = JSON.parse(raw) as unknown
    if (!Array.isArray(value)) return []
    return value.filter((a): a is AccountEntry =>
      !!a && typeof a === 'object'
      && typeof (a as AccountEntry).userId === 'string'
      && typeof (a as AccountEntry).refreshToken === 'string')
  } catch { return [] }
}

function readSession(): string | null {
  try { return sessionStorage.getItem(ACCOUNTS_KEY) } catch { return null }
}

function writeSession(accounts: AccountEntry[]): void {
  try { sessionStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts)) } catch { /* stockage indisponible */ }
}

const sessionAccounts: AccountStorage = {
  load: () => parseAccounts(readSession()),
  save: writeSession,
}

/**
 * Comptes gardes en memoire, recopies dans sessionStorage, et confies a
 * `persist` a chaque changement (version bureau : fichier cote Rust).
 */
export function persistedAccounts(initial: AccountEntry[], persist: (accounts: AccountEntry[]) => void): AccountStorage {
  let cache = initial
  writeSession(cache)
  return {
    load: () => cache,
    save: (accounts) => {
      cache = accounts
      writeSession(accounts)
      persist(accounts)
    },
  }
}

let storage: AccountStorage = sessionAccounts

export function getAccountStorage(): AccountStorage {
  return storage
}

/** Pose le stockage des comptes (version bureau) ; null : retour a sessionStorage. */
export function setAccountStorage(next: AccountStorage | null): void {
  storage = next ?? sessionAccounts
}
