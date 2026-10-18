// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Constantes du profil bureau qu'AppShell lit sans charger le bureau : ce
// fichier reste dans le bundle web, createDesktopRoot.ts non.

import type { AccountEntry } from './types'

/** Compte de la version bureau sans serveur. Jamais envoye a un serveur. */
export const OFFLINE_ACCOUNT: AccountEntry = {
  userId: 'local',
  email: '',
  displayName: 'Moi (local)',
  refreshToken: '',
  isActive: true,
}

/** Jeton factice : les services locaux l'ignorent, il ne part nulle part. */
export const OFFLINE_TOKEN = 'local'

/** Role affiche d'un vault local dont le dossier existe. */
export const LOCAL_VAULT_ROLE = 'local'
/** Role affiche d'un vault local dont le dossier a disparu. */
export const MISSING_VAULT_ROLE = 'introuvable'
