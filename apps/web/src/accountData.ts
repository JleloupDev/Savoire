// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Les donnees d'un compte : les exporter (un .zip de ce que la personne
// possede), supprimer le compte. L'etat de l'inscription s'y lit aussi.
//
// L'export reunit : compte.json (le profil), puis un dossier par vault que la
// personne possede. Un vault du serveur est copie par le transfert habituel
// (dans un dossier en memoire) ; un vault du poste (version bureau) est lu
// tel quel sur le disque.
import type { IVaultFileSystem } from '@savoire/platform'
import { createZip, type ZipEntry } from './zipArchive'
import { safeFileName, zipEntriesOf } from './vaultTransfer'

export interface ExportableVault { id: string; name: string; role: string; source?: string }

export interface AccountProfile {
  id: string; displayName: string; email: string; isAdmin: boolean; signupClosed: boolean
  /** Page du fournisseur d'identite pour ajouter une cle d'acces ; absente si le serveur n'en a pas. */
  passkeyUrl?: string
}

/** L'adresse de la page d'ajout de cle d'acces, pour ce compte. */
export function passkeyPageUrl(profile: Pick<AccountProfile, 'email' | 'passkeyUrl'>): string | null {
  if (!profile.passkeyUrl || !profile.email) return null
  const url = new URL(profile.passkeyUrl)
  url.searchParams.set('loginName', profile.email)
  return url.toString()
}

export interface AccountExportDeps {
  profile: Pick<AccountProfile, 'id' | 'displayName' | 'email'>
  vaults: ExportableVault[]
  /** Dossier en memoire pour y copier un vault du serveur. */
  memoryFolder(name: string): IVaultFileSystem
  /** Copie un vault du serveur dans le dossier ; rend ses erreurs. */
  copyServerVault(vault: ExportableVault, fs: IVaultFileSystem): Promise<string[]>
  /** Le dossier d'un vault du poste (version bureau). Absent : les vaults du poste sont ignores. */
  localFolder?(vault: ExportableVault): Promise<IVaultFileSystem>
  now?(): Date
}

export interface AccountExport {
  blob: Blob
  /** Nombre de vaults dans l'archive. */
  vaults: number
  errors: string[]
}

/** Seuls les vaults dont la personne est proprietaire, et ceux de son poste. */
export function ownedVaults(vaults: ExportableVault[]): ExportableVault[] {
  return vaults.filter(v => v.role === 'owner' || v.source === 'local')
}

/** Un nom de dossier par vault, sans doublon (« Notes », « Notes (2) »). */
function folderNames(vaults: ExportableVault[]): string[] {
  const used = new Set<string>()
  return vaults.map(v => {
    const base = safeFileName(v.name)
    let name = base
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${n})`
    used.add(name.toLowerCase())
    return name
  })
}

export async function buildAccountExport(deps: AccountExportDeps): Promise<AccountExport> {
  const errors: string[] = []
  const owned = ownedVaults(deps.vaults)
  const names = folderNames(owned)
  const entries: ZipEntry[] = []
  let count = 0
  for (const [i, vault] of owned.entries()) {
    const prefix = `${names[i]}/`
    try {
      let fs: IVaultFileSystem
      if (vault.source === 'local') {
        if (!deps.localFolder) continue
        fs = await deps.localFolder(vault)
      } else {
        fs = deps.memoryFolder(vault.name)
        for (const e of await deps.copyServerVault(vault, fs)) errors.push(`${vault.name} : ${e}`)
      }
      const files = await zipEntriesOf(fs, prefix)
      // Un vault vide garde son dossier dans l'archive.
      entries.push(...(files.length ? files : [{ path: prefix }]))
      count++
    } catch (err) {
      errors.push(`${vault.name} : ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const info = {
    exportedAt: (deps.now?.() ?? new Date()).toISOString(),
    account: { id: deps.profile.id, displayName: deps.profile.displayName, email: deps.profile.email },
    vaults: owned.map((v, i) => ({ id: v.id, name: v.name, folder: names[i] })),
    ...(errors.length ? { errors } : {}),
  }
  entries.unshift({ path: 'compte.json', bytes: new TextEncoder().encode(JSON.stringify(info, null, 2)) })
  return { blob: createZip(entries), vaults: count, errors }
}

export const DELETE_CONFIRMATION = 'SUPPRIMER'

/** Un appel a l'API du serveur, avec le jeton de la personne (donne par la coquille). */
export type ApiCall = (method: string, path: string, body?: unknown) => Promise<Response>

/** L'appel standard : l'adresse du serveur vient de `resolve` (serverUrl). */
export function apiCaller(token: () => string, resolve: (path: string) => string): ApiCall {
  return (method, path, body) => fetch(resolve(path), {
    method,
    headers: { Authorization: `Bearer ${token()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
}

export async function fetchAccountProfile(call: ApiCall): Promise<AccountProfile> {
  const res = await call('GET', '/api/v1/auth/me')
  if (!res.ok) throw new Error(`Compte illisible (${res.status}).`)
  const j = await res.json() as Partial<AccountProfile>
  return {
    id: String(j.id ?? ''), displayName: String(j.displayName ?? ''), email: String(j.email ?? ''),
    isAdmin: j.isAdmin === true, signupClosed: j.signupClosed === true,
    passkeyUrl: typeof j.passkeyUrl === 'string' && /^https?:\/\//.test(j.passkeyUrl) ? j.passkeyUrl : undefined,
  }
}

/** Supprime le compte et ses vaults (le serveur efface aussi chez le fournisseur d'identite). */
export async function deleteAccount(call: ApiCall): Promise<void> {
  const res = await call('DELETE', '/api/v1/auth/me', { confirm: DELETE_CONFIRMATION })
  if (res.ok) return
  let detail = ''
  try { detail = (await res.json() as { detail?: string; title?: string }).detail ?? '' } catch { /* corps vide */ }
  throw new Error(detail || `Suppression refusée (${res.status}).`)
}
