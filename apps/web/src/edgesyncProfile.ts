// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Profil EdgeSync : le SEUL fichier de l'app qui touche
// @savoire/infrastructure-edgesync. Rien ne l'importe par defaut,
// createWebAppRoot() construit le profil serveur Savoire.
//
//   createWebAppRoot({ ..., vaultSyncSessionFactory: makeEdgesyncVaultSessionFactory(...) })
//
// ATTENTION (30/08/2026) : ce profil ne compile pas contre la version actuelle
// du depot EdgeSync voisin (API Keyring/Session modifiee apres la scission des
// depots : genesis / currentEpoch / mintDocKey / rotate n'existent plus). Il
// est donc exclu du tsconfig de apps/web. Le profil serveur n'en depend pas.
import type { IVaultSyncSessionFactory } from '@savoire/application'
import {
  EdgesyncVaultSession, EdgesyncVaultSyncSession, RemoteEdgesyncBlobStorage,
  VaultKeyEscrow, WrongVaultKeyError,
} from '@savoire/infrastructure-edgesync'
import { setKeyCustody } from './keyCustody'

/** Installe la garde de cles propre a EdgeSync : a partir de la, une K_User
 *  devient necessaire (badges « verrouille », ceremonie de cle). A appeler une
 *  fois, avant le rendu, quand l'app tourne en profil EdgeSync. */
export function installEdgesyncKeyCustody(
  getToken: () => string | null,
  getVaultKey: () => Uint8Array | null,
): void {
  const escrow = new VaultKeyEscrow({ getToken, getVaultKey })
  setKeyCustody({
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
): IVaultSyncSessionFactory {
  return {
    open: async (params) => {
      const identitySeed = params.identitySeed
      if (!identitySeed) throw new Error('EdgeSync requires a 32-byte Ed25519 identity seed')
      return EdgesyncVaultSyncSession.open(
        { vaultId: params.vaultId, identitySeed, getToken, getVaultKey, onChanged: params.onChanged },
        // Le serveur ne voit que du chiffre : blobs de contenu
        // (RemoteEdgesyncBlobStorage) et escrow du Keyring (VaultKeyEscrow,
        // enveloppe sous la K_User du compte) lui sont tous deux opaques.
        (directory) => EdgesyncVaultSession.open({
          vaultId: params.vaultId,
          identitySeed,
          directory,
          serverUrl: '',
          getToken,
          storage: new RemoteEdgesyncBlobStorage({ vaultId: params.vaultId, getToken }),
          keyEscrow: new VaultKeyEscrow({ getToken, getVaultKey }),
        }),
      )
    },
  }
}
