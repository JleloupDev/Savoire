// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Port local : « ce vault est-il verrouille pour ce compte ? ». Notion propre au
// profil EdgeSync (un vault chiffre dont le Keyring ne se deverrouille qu'avec
// K_User). En profil serveur Savoire, aucun probe n'est installe et tous les
// vaults sont ouverts.
//
// Existe pour que AppShell n'importe PAS @savoire/infrastructure-edgesync :
// l'implementation est fournie par edgesyncProfile.ts, au composition root.

export interface IVaultLockProbe {
  /** true = ce vault est verrouille (mauvaise cle / pas de cle) pour le compte courant. */
  isLocked(vaultId: string): Promise<boolean>
  /** true si cette erreur d'activation signifie « mauvaise K_User pour ce vault »
   *  (WrongVaultKeyError cote connecteur). Permet a AppShell de reagir sans
   *  importer le connecteur. */
  isWrongKeyError(err: unknown): boolean
}

let probe: IVaultLockProbe | undefined

/** Appele par le profil EdgeSync uniquement. */
export function setVaultLockProbe(p: IVaultLockProbe): void {
  probe = p
}

export function getVaultLockProbe(): IVaultLockProbe | undefined {
  return probe
}
