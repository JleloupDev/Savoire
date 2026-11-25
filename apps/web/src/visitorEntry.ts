// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Ou envoyer une personne non connectee qui arrive sur l'appli.
// Navigateur, premiere visite : la page vitrine (/decouvrir).
// Quelqu'un qui a deja un compte enregistre (session expiree) ou l'appli
// de bureau : directement la connexion.

export const LANDING_PATH = '/decouvrir'

export function visitorEntryPath({ desktop, savedAccounts }: { desktop: boolean; savedAccounts: number }): string {
  return desktop || savedAccounts > 0 ? '/login' : LANDING_PATH
}
