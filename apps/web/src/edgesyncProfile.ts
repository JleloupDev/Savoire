// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Profil EdgeSync — le SEUL fichier de l'app qui touche @savoire/infrastructure-edgesync.
// Rien ne l'importe par défaut : createWebAppRoot() construit le profil serveur
// Savoire. Pour basculer l'app en P2P, passer le retour de
// makeEdgesyncVaultSessionFactory() à createWebAppRoot({ edgesyncVaultSessionFactory }).
//
// ATTENTION (30/08/2026) : ce profil ne compile pas contre la version actuelle du
// dépôt EdgeSync voisin (API Keyring/Session modifiee apres la scission des depots
// -- genesis/currentEpoch/mintDocKey/rotate n'existent plus). Le profil serveur,
// lui, est intact et ne depend pas de ce fichier.
import type { IEdgesyncVaultSessionFactory } from '@savoire/application'
import type { YMapVaultDirectory } from '@savoire/infrastructure-sync'
import {
  EdgesyncVaultSession, RemoteEdgesyncBlobStorage, VaultKeyEscrow, WrongVaultKeyError,
} from '@savoire/infrastructure-edgesync'
import { setVaultLockProbe } from './vaultLock'

/** Installe la sonde de verrouillage propre a EdgeSync (badges « verrouille »).
 *  A appeler une fois, avant le rendu, quand l'app tourne en profil EdgeSync. */
export function installEdgesyncVaultLockProbe(
  getToken: () => string | null,
  getVaultKey: () => Uint8Array | null,
): void {
  const escrow = new VaultKeyEscrow({ getToken, getVaultKey })
  setVaultLockProbe({
    async isLocked(vaultId) {
      try { await escrow.fetch(vaultId); return false }
      catch (err) { return err instanceof WrongVaultKeyError }
    },
    isWrongKeyError: (err) => err instanceof WrongVaultKeyError,
  })
}

export function makeEdgesyncVaultSessionFactory(
  getToken: () => string | null,
  getVaultKey: () => Uint8Array | null,
): IEdgesyncVaultSessionFactory {
  return {
    // The server only ever sees ciphertext: content blobs
    // (RemoteEdgesyncBlobStorage) and the Keyring escrow (VaultKeyEscrow,
    // wrapped under the account's K_User) are both opaque to it. One instance
    // per open() call (cheap — no connection of their own, just a fetch()
    // closure) so each is scoped to that vaultId.
    open: ({ vaultId, identitySeed, directory }) =>
      EdgesyncVaultSession.open({
        vaultId,
        identitySeed,
        // The app always constructs a real YMapVaultDirectory for `directory`
        // (AppShell.tsx); IVaultDirectory itself stays edgesync-agnostic to
        // avoid a dependency cycle (infrastructure-sync already depends on
        // @savoire/application).
        directory: directory as YMapVaultDirectory,
        serverUrl: '',
        getToken,
        storage: new RemoteEdgesyncBlobStorage({ vaultId, getToken }),
        keyEscrow: new VaultKeyEscrow({ getToken, getVaultKey }),
      }),
  }
}
