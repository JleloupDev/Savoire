// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Vault disparu : le serveur dit « vault-not-found » (vault supprime, ou acces
// retire). Ce n'est pas un alea reseau : reessayer ne servira a rien. Le
// profil serveur arrete alors tout le reseau du vault et previent la session
// une seule fois.
//
// Le code vient du filtre des hubs (HubErrorFilter cote serveur) : le message
// d'une HubException arrive tel quel, precede de « HubException: ».
import { VaultGoneError } from '@savoire/application'

/** Code stable du serveur : le vault n'existe pas, ou on n'y a plus acces. */
export const VAULT_NOT_FOUND_CODE = 'vault-not-found'

const VAULT_GONE_PATTERN = new RegExp(`(^|HubException: )${VAULT_NOT_FOUND_CODE}($|[^a-z-])`)

/** L'erreur dit-elle que le vault est perdu ? (et pas un document absent, ni un alea) */
export function isVaultGoneError(err: unknown): boolean {
  if (err instanceof VaultGoneError) return true
  const text = err instanceof Error ? err.message : String(err ?? '')
  return VAULT_GONE_PATTERN.test(text)
}

/**
 * Signal partage par les clients d'un meme vault (hub du vault, documents,
 * rooms). Le premier qui voit le code le declenche ; les autres s'arretent.
 */
export class VaultGoneSignal {
  private isGone = false
  private readonly listeners = new Set<() => void>()

  constructor(readonly vaultId: string) {}

  get gone(): boolean { return this.isGone }

  /** Declenche le signal si l'erreur le justifie. Rend true si le vault est perdu. */
  check(err: unknown): boolean {
    if (!isVaultGoneError(err)) return false
    this.trigger()
    return true
  }

  /** Une seule fois : les appels suivants ne font rien. */
  trigger(): void {
    if (this.isGone) return
    this.isGone = true
    console.warn(`[sync] le vault ${this.vaultId} n'existe plus ou l'acces a ete retire : synchronisation arretee`)
    for (const cb of [...this.listeners]) {
      try { cb() } catch (err) { console.error('[sync] VaultGoneSignal listener failed', err) }
    }
  }

  onGone(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }
}
