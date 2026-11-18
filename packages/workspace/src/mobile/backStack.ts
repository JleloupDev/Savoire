// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le bouton retour du telephone, partage entre les fenetres et les ecrans.
//
// Une fenetre ouverte (parametres, partage...) s'inscrit ici : « retour » la
// ferme avant de changer d'ecran. Chaque inscription ajoute une entree a
// l'historique du navigateur ; une fenetre fermee par son propre bouton retire
// la sienne sans que l'ecran recule.

const handlers: Array<() => void> = []
let skipPops = 0

function pushEntry(): void {
  window.history.pushState({ ...(window.history.state as object | null), savoireMobile: true }, '')
}

/** Ajoute une entree d'historique pour un pas de navigation (ecran, volet). */
export function pushMobileHistory(): void {
  pushEntry()
}

/**
 * Une fenetre s'ouvre : « retour » appellera `close`. Rend la fonction a
 * appeler quand la fenetre se ferme (par n'importe quel moyen).
 */
export function registerMobileBack(close: () => void): () => void {
  handlers.push(close)
  pushEntry()
  return () => {
    const i = handlers.indexOf(close)
    if (i === -1) return // deja fermee par « retour » : l'entree est consommee
    handlers.splice(i, 1)
    // Fermee par son bouton : on retire son entree, sans reculer d'ecran.
    skipPops++
    window.history.back()
  }
}

/**
 * Un « retour » est arrive (popstate). Vrai s'il est traite ici : entree
 * retiree par une fenetre, ou fenetre fermee. Faux : a l'ecran de reculer.
 */
export function consumeMobileBack(): boolean {
  if (skipPops > 0) { skipPops--; return true }
  const close = handlers.pop()
  if (!close) return false
  close()
  return true
}
