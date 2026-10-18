// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Les vaults recents, vus du front : la liste vit cote Rust (dossier de
// configuration de l'application, voir src-tauri/src/vaults.rs), ici on ne
// fait que la traduire pour l'application.

/** Un dossier de vault connu, tel que le rend Rust. */
export interface RecentVault {
  /** Chemin absolu canonique : identifie la racine aupres de Rust. */
  path: string
  /** Nom affiche (par defaut le nom du dossier). */
  name: string
  lastOpenedMs: number
  /** Absent quand Rust vient de l'ouvrir : il existe alors forcement. */
  exists?: boolean
}

/** Prefixe des identifiants de vault sur disque. */
export const DESKTOP_VAULT_PREFIX = 'disk:'

/** Identifiant de vault d'un dossier : stable tant que le dossier ne bouge pas. */
export function vaultIdForPath(path: string): string {
  return DESKTOP_VAULT_PREFIX + path
}

export function pathForVaultId(vaultId: string): string | null {
  return vaultId.startsWith(DESKTOP_VAULT_PREFIX) ? vaultId.slice(DESKTOP_VAULT_PREFIX.length) : null
}

/** Les plus recents d'abord ; les dossiers introuvables a la fin. */
export function sortRecent(list: readonly RecentVault[]): RecentVault[] {
  return [...list].sort((a, b) => {
    const ea = a.exists === false ? 1 : 0
    const eb = b.exists === false ? 1 : 0
    return ea - eb || b.lastOpenedMs - a.lastOpenedMs
  })
}

/** Chemin raccourci pour l'affichage : « ~/Notes/Projet » plutot que /home/x/Notes/Projet. */
export function displayPath(path: string, home?: string): string {
  const norm = path.replace(/\\/g, '/')
  if (home) {
    const h = home.replace(/\\/g, '/').replace(/\/+$/, '')
    if (norm === h) return '~'
    if (norm.startsWith(h + '/')) return '~' + norm.slice(h.length)
  }
  return norm
}
