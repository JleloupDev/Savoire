// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Icones de l'appli, pour les plugins. Une icone se nomme comme chez Lucide
// (lucide.dev/icons : « file-text », « trash-2 »), la famille d'Obsidian.
// Partout ou un plugin donne une icone (vue, type de fichier, commande,
// menu « / »), il donne un de ces noms ; un texte court (emoji) reste
// accepte et s'affiche tel quel.

export interface IconOptions {
  /** Taille en px (16 par defaut). */
  size?: number
  /** Classe CSS ajoutee a l'element. */
  className?: string
  /** Texte lu par les lecteurs d'ecran ; sans lui l'icone est decorative. */
  label?: string
}

export interface IconAPI {
  /** Element pret a inserer dans le DOM (un <span> qui contient le dessin). */
  create(name: string, options?: IconOptions): HTMLElement
}

/**
 * Icone pour un plugin en DOM : celle de l'hote, sinon le nom en texte.
 * `api.icons` est facultatif (tests, hote ancien) : passer par ici evite
 * de traiter son absence a chaque appel.
 */
export function createIcon(icons: IconAPI | undefined, name: string, options: IconOptions = {}): HTMLElement {
  if (icons) return icons.create(name, options)
  const span = document.createElement('span')
  if (options.className) span.className = options.className
  span.textContent = name
  if (options.label) { span.setAttribute('role', 'img'); span.setAttribute('aria-label', options.label) } else span.setAttribute('aria-hidden', 'true')
  return span
}
