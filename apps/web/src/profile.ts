// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Choix du profil de synchronisation au demarrage, pilotable par l'URL :
//
//   ?profile=server     (defaut) serveur Savoire, le serveur lit les donnees
//   ?profile=edgesync   P2P, E2E, serveur aveugle
//   ?profile=local      pairs = onglets du navigateur, aucune synchro serveur.
//                       Garde-fou du portage P2P : pas d'arbitre (pas de
//                       verrous), pas de persistance hors des onglets ouverts.
//                       Comptes et liste des vaults restent servis par le serveur.
//   desktop             version bureau (fenetre Tauri) : choisi tout seul
//                       quand l'app tourne dans Tauri. Profil UNIFIE : les
//                       dossiers du disque (aucun compte requis) et, si la
//                       personne se connecte a un serveur, les vaults de son
//                       compte, dans la meme session. Voir createDesktopRoot.ts.
//                       Android (Tauri aussi) : profil serveur, avec le
//                       choix du serveur et sa session gardee, sans disque.
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

import { makeLocalPeerVaultSessionFactory } from './createWebAppRoot'
import { isAndroidRuntime, isTauriRuntime } from './tauriRuntime'
import { OFFLINE_ACCOUNT, OFFLINE_TOKEN } from './desktopAccount'
import { installDesktopServers } from './serverConnection'
import { notify } from '@savoire/notifications'
import { t } from '@savoire/i18n'

export type SyncProfileName = 'server' | 'edgesync' | 'local' | 'desktop'

const KNOWN: readonly SyncProfileName[] = ['server', 'edgesync', 'local', 'desktop']

/**
 * Dans Tauri, le profil bureau d'office (un ?profile= explicite l'emporte,
 * pour les tests). Hors de Tauri, ou sous Android (serveur seulement), le
 * profil bureau n'a pas de disque : refuse.
 */
export function readProfileFromUrl(
  search: string = window.location.search,
  inTauri: boolean = isTauriRuntime(),
  android: boolean = isAndroidRuntime(),
): SyncProfileName {
  const raw = new URLSearchParams(search).get('profile')
  const withDisk = inTauri && !android
  if (raw === 'desktop' && !withDisk) {
    console.warn('[profile] le profil bureau ne marche que dans l\'application de bureau, retour au profil serveur')
    return 'server'
  }
  if (raw && (KNOWN as readonly string[]).includes(raw)) return raw as SyncProfileName
  if (raw) console.warn(`[profile] valeur inconnue "${raw}", retour au profil serveur`)
  return withDisk ? 'desktop' : 'server'
}

/** Ce que le profil bureau ajoute (voir createDesktopRoot.ts). */
export interface DesktopProfileExtras {
  host: import('@savoire/desktop').DesktopHost
  /** Retient un dossier qui vient d'etre choisi, rend son vault. */
  rememberFolder(folder: import('@savoire/desktop').OpenedVaultFolder): import('@savoire/application').AppVaultSummary
  /**
   * Point d'accroche du transfert serveur <-> disque : la personne choisit un
   * dossier, on rend son systeme de fichiers (null si elle annule). Le
   * dossier est autorise et ajoute aux vaults recents.
   */
  pickVaultFolder(): Promise<import('@savoire/platform').IVaultFileSystem | null>
  /** Dossier d'un vault de la version bureau (null : pas un dossier). */
  pathOfVault(vaultId: string): string | null
  /** D'ou vient un vault : un dossier ('local') ou le compte du serveur ('server'). */
  sourceOf(vaultId: string): 'local' | 'server'
  /** Nouveau vault : un dossier (la personne choisit ou) ou un vault du serveur. */
  createVaultOn(source: 'local' | 'server', name: string): Promise<import('@savoire/application').AppVaultSummary>
  /** Erreur de la derniere liste des vaults du serveur (null : aucune). */
  serverListError(): unknown
  /** La personne a ferme la boite de dialogue du dossier : pas une erreur. */
  isCancelled(err: unknown): boolean
}

export interface LoadedProfile {
  name: SyncProfileName
  /** Undefined = profil serveur (createWebAppRoot construit sa fabrique lui-meme). */
  vaultSyncSessionFactory?: import('@savoire/application').IVaultSyncSessionFactory
  /** Undefined = liste des vaults du serveur. */
  vaultsBackend?: import('@savoire/application').IVaultsBackend
  /** Undefined = cle d'identite servie par le serveur. */
  identityProvider?: import('@savoire/plugin-api').IIdentityProvider
  /** Profil utilisable sans compte : compte et jeton locaux quand personne
   *  n'est connecte, l'app ne renvoie pas vers la connexion. */
  offline?: { account: import('./types').AccountEntry; token: string }
  /** Profil bureau seulement. */
  desktop?: DesktopProfileExtras
  /** Renseigne si le profil demande n'a pas pu etre charge. */
  error?: string
}

/** Le profil bureau actif, ou undefined (navigateur). */
export function getDesktopProfile(): DesktopProfileExtras | undefined {
  return active.desktop
}

export async function loadProfile(
  name: SyncProfileName,
  deps: { getToken: () => string | null; getVaultKey: () => Uint8Array | null },
): Promise<LoadedProfile> {
  if (name === 'server') return { name: 'server' }
  if (name === 'local') {
    return {
      name: 'local',
      vaultSyncSessionFactory: makeLocalPeerVaultSessionFactory(),
    }
  }
  if (name === 'desktop') {
    try {
      // Import dynamique : le bureau (et @tauri-apps/api) hors du bundle web.
      const mod = await import('./createDesktopRoot')
      const parts = await mod.loadDesktopProfile(desktopOptions())
      return {
        name: 'desktop',
        vaultSyncSessionFactory: parts.vaultSyncSessionFactory,
        vaultsBackend: parts.vaultsBackend,
        identityProvider: parts.identityProvider,
        offline: { account: OFFLINE_ACCOUNT, token: OFFLINE_TOKEN },
        desktop: {
          host: parts.host,
          rememberFolder: (folder) => parts.opened.remember(folder),
          pathOfVault: mod.pathOfVault,
          sourceOf: mod.sourceOfVault,
          createVaultOn: (source, vaultName) => parts.vaultsBackend.createVaultOn(source, vaultName),
          serverListError: () => parts.vaultsBackend.serverError(),
          isCancelled: (err) => err instanceof mod.FolderPickCancelled,
          pickVaultFolder: async () => {
            const folder = await parts.host.pickVaultFolder()
            if (!folder) return null
            parts.opened.remember(folder)
            return folder.fs
          },
        },
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[profile] profil bureau indisponible, retour au profil serveur:', msg)
      return { name: 'server', error: `Profil bureau indisponible : ${msg}` }
    }
  }

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
  /** Compte reellement connecte au serveur (pas le compte local du bureau), ou null. */
  getServerAuth?: () => { token: string; userId: string } | null
}

let runtimeDeps: ProfileRuntimeDeps = { getToken: () => null, getVaultKey: () => null }
let active: LoadedProfile = { name: 'server' }

/** Le profil bureau lit le compte serveur connecte a chaque appel (AppShell le fournit). */
function desktopOptions(): import('./createDesktopRoot').DesktopProfileOptions {
  return {
    getServerAuth: () => runtimeDeps.getServerAuth?.() ?? null,
    onConnectionChange: (state) => {
      if (state === 'disconnected') notify('warn', t('app', 'sync.disconnected'))
      else notify('success', t('app', 'sync.reconnected'))
    },
  }
}

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
  // Dans Tauri, quel que soit le profil : le disque sert aussi au transfert
  // serveur <-> disque (telecharger un vault du serveur dans un dossier...).
  if (isTauriRuntime() && isAndroidRuntime()) {
    // Android : pas de disque, seulement le serveur choisi et sa session.
    try {
      const mod = await import('./createDesktopRoot')
      await installDesktopServers(await mod.loadServerSettings())
    } catch (err) {
      console.error('[profile] serveurs connus illisibles', err)
    }
  } else if (isTauriRuntime()) {
    try {
      const mod = await import('./createDesktopRoot')
      const parts = await mod.loadDesktopProfile(desktopOptions())
      mod.installVaultFolderHost(parts, () => runtimeDeps.getServerAuth?.() ?? null)
      // Le serveur choisi par la personne : base des URL, comptes gardes.
      await installDesktopServers(parts.serverSettings)
    } catch (err) {
      console.error('[profile] disque indisponible pour les transferts', err)
    }
  }
  return active
}
