// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Telecommande d'une presentation par telephone : le protocole est dans
// plugin-api (slideRemote.ts). Ici, le transport que l'appli donne a
// l'editeur (la presentation l'ouvre a la demande).
import type { SlideRemoteLink } from '@savoire/plugin-api'

/**
 * Ouvre un lien pour la note `docId`. Quand ce n'est pas possible (vault
 * local, sans serveur), rend la raison a montrer.
 */
export type SlideRemoteFactory = (docId: string) => SlideRemoteLink | { reason: string }

let factory: SlideRemoteFactory | null = null

/** L'appli donne son transport (une seule fois, au demarrage). */
export function setSlideRemoteFactory(f: SlideRemoteFactory | null): void {
  factory = f
}

export function slideRemoteFactory(): SlideRemoteFactory | null {
  return factory
}

