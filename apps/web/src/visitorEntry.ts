// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Ou envoyer une personne non connectee qui arrive sur l'appli.
// Navigateur, premiere visite : la page vitrine (/decouvrir).
// Quelqu'un qui a deja un compte enregistre (session expiree), l'appli
// de bureau ou un telephone qui vient du code QR d'une presentation :
// directement la connexion.

export const LANDING_PATH = '/decouvrir'

export function visitorEntryPath({ desktop, savedAccounts, slideRemote = false }: { desktop: boolean; savedAccounts: number; slideRemote?: boolean }): string {
  return desktop || savedAccounts > 0 || slideRemote ? '/login' : LANDING_PATH
}
