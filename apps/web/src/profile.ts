// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Choix du profil de synchronisation au demarrage, pilotable par l'URL :
//
//   ?profile=server     (defaut) serveur Savoire, le serveur lit les donnees
//   ?profile=edgesync   P2P, E2E, serveur aveugle
//
// Sert d'abord aux tests : les deux profils se lancent cote a cote sans
// recompiler ni toucher au composition root. Le jour ou un connecteur
// automerge-repo/Beelay existe, il s'ajoute ici et nulle part ailleurs.
//
// Le connecteur EdgeSync est charge DYNAMIQUEMENT : il ne doit jamais entrer
// dans le bundle du profil serveur, et il ne compile pas aujourd'hui contre
// l'API du depot EdgeSync voisin (voir edgesyncProfile.ts). Un
// ?profile=edgesync echoue donc proprement, avec un message, plutot que de
// casser le demarrage.

export type SyncProfileName = 'server' | 'edgesync'

const KNOWN: readonly SyncProfileName[] = ['server', 'edgesync']

export function readProfileFromUrl(search: string = window.location.search): SyncProfileName {
  const raw = new URLSearchParams(search).get('profile')
  if (raw && (KNOWN as readonly string[]).includes(raw)) return raw as SyncProfileName
  if (raw) console.warn(`[profile] valeur inconnue "${raw}", retour au profil serveur`)
  return 'server'
}

export interface LoadedProfile {
  name: SyncProfileName
  /** Undefined = profil serveur (createWebAppRoot construit sa fabrique lui-meme). */
  vaultSyncSessionFactory?: import('@savoire/application').IVaultSyncSessionFactory
  /** Renseigne si le profil demande n'a pas pu etre charge. */
  error?: string
}

export async function loadProfile(
  name: SyncProfileName,
  deps: { getToken: () => string | null; getVaultKey: () => Uint8Array | null },
): Promise<LoadedProfile> {
  if (name === 'server') return { name: 'server' }

  try {
    // Specificateur VARIABLE, et non litteral, volontairement : un import()
    // litteral ferait suivre ./edgesyncProfile a TypeScript, donc le connecteur
    // — qui ne compile pas contre l'API actuelle du depot EdgeSync. Le module
    // reste donc `any` ici, et hors du graphe du profil serveur.
    // A repasser en import() litteral typé le jour du realignement : ce sera
    // le signal que le connecteur est de nouveau sain.
    const specifier = './edgesyncProfile'
    const mod = await import(/* @vite-ignore */ specifier) as {
      installEdgesyncKeyCustody: (getToken: () => string | null, getVaultKey: () => Uint8Array | null) => void
      makeEdgesyncVaultSessionFactory: (
        getToken: () => string | null, getVaultKey: () => Uint8Array | null,
      ) => import('@savoire/application').IVaultSyncSessionFactory
    }
    mod.installEdgesyncKeyCustody(deps.getToken, deps.getVaultKey)
    return {
      name: 'edgesync',
      vaultSyncSessionFactory: mod.makeEdgesyncVaultSessionFactory(deps.getToken, deps.getVaultKey),
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[profile] connecteur edgesync indisponible, retour au profil serveur:', msg)
    return { name: 'server', error: `Profil edgesync indisponible : ${msg}` }
  }
}

// ── Profil actif du processus ────────────────────────────────────────────────
//
// Resolu UNE fois au demarrage (main.tsx), avant le premier rendu : installer
// une garde de cles apres coup laisserait l'UI afficher un etat faux entre les
// deux. Les acces au jeton et a K_User passent par une indirection, parce que
// le profil se resout avant qu'AppShell n'existe, alors que ces closures ne
// sont appelees que bien plus tard (a l'activation d'un vault).

interface ProfileRuntimeDeps {
  getToken: () => string | null
  getVaultKey: () => Uint8Array | null
}

let runtimeDeps: ProfileRuntimeDeps = { getToken: () => null, getVaultKey: () => null }
let active: LoadedProfile = { name: 'server' }

/** Appele par AppShell des son premier rendu. */
export function setProfileRuntimeDeps(deps: ProfileRuntimeDeps): void {
  runtimeDeps = deps
}

export function getActiveProfile(): LoadedProfile {
  return active
}

/** Appele une fois par main.tsx, avant createRoot().render(). */
export async function initProfile(): Promise<LoadedProfile> {
  active = await loadProfile(readProfileFromUrl(), {
    getToken: () => runtimeDeps.getToken(),
    getVaultKey: () => runtimeDeps.getVaultKey(),
  })
  return active
}
