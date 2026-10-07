// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Activation des plugins. Un plugin desactive n'est PAS decharge : il reste en
// memoire, mais tout ce qu'il a enregistre (types de fichiers, blocs,
// commandes, vues, index...) est filtre a la lecture. C'est la meme philosophie
// que l'activation par note (ADR-012), etendue a l'application entiere.
//
// Deux raisons :
//   - les registres ne savent pas desinscrire, et un dechargement partiel
//     laisserait des traces ;
//   - reactiver est instantane, sans recharger la page.
//
// Rien n'est jamais detruit : les donnees d'un plugin desactive restent dans
// le vault, intactes.

export class PluginActivation {
  private disabled = new Set<string>()
  private readonly listeners = new Set<() => void>()

  /**
   * Plugin en cours de chargement (pendant son onload). Chaque registre
   * tamponne avec cet id ce qu'il enregistre. Undefined = l'application
   * elle-meme, toujours active.
   */
  currentPluginId: string | undefined

  /** Un enregistrement sans plugin (fait par l'application) est toujours actif. */
  isEnabled(pluginId: string | undefined): boolean {
    return pluginId === undefined || !this.disabled.has(pluginId)
  }

  getDisabled(): ReadonlySet<string> {
    return this.disabled
  }

  /** Remplace l'ensemble des plugins desactives. Notifie seulement si ca change. */
  setDisabled(ids: Iterable<string>): void {
    const next = new Set(ids)
    if (next.size === this.disabled.size && [...next].every(id => this.disabled.has(id))) return
    this.disabled = next
    for (const cb of [...this.listeners]) cb()
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }
}
