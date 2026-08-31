// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Garde des cles : port local, installe par le seul profil qui en a besoin.
//
// Par defaut, l'utilisateur n'a AUCUNE ceremonie de cle a subir : le profil
// serveur Savoire ne chiffre pas cote client, il n'y a donc pas de K_User a
// fournir. Gerer sa propre cle est une option explicite, jamais un peage sur
// le chemin de la creation d'un vault.
//
// Un profil a cles (EdgeSync aujourd'hui, Keyhive demain) installe une garde
// via setKeyCustody() : a partir de la, une K_User devient necessaire pour
// ouvrir ou creer un vault, et l'app le demande.
//
// Existe pour que AppShell n'importe aucun connecteur : l'implementation vient
// du composition root (voir edgesyncProfile.ts).

export interface IKeyCustody {
  /** true = ce vault est verrouille (mauvaise cle / pas de cle) pour le compte courant. */
  isLocked(vaultId: string): Promise<boolean>
  /** true si cette erreur d'activation signifie « mauvaise K_User pour ce vault ». */
  isWrongKeyError(err: unknown): boolean
}

let custody: IKeyCustody | undefined

/** Appele par un profil a cles uniquement, avant le rendu. */
export function setKeyCustody(c: IKeyCustody): void {
  custody = c
}

export function getKeyCustody(): IKeyCustody | undefined {
  return custody
}

/**
 * Le profil actif exige-t-il une cle utilisateur ?
 * false (defaut) = le serveur s'occupe de tout, aucune modale imposee.
 */
export function requiresUserKey(): boolean {
  return custody !== undefined
}
