// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Interface mobile : ce que les paquets hors de l'appli doivent savoir d'elle.
// Aujourd'hui, le bouton retour du telephone ferme la presentation en cours
// (sinon il ferait reculer l'ecran de dessous).
import { setSlideShowBackHandler } from '@savoire/editor-core'
import { registerMobileBack } from '@savoire/workspace'
import { layoutMode } from './layoutMode'

export function installMobileHooks(): void {
  if (layoutMode() !== 'mobile') return
  setSlideShowBackHandler(registerMobileBack)
}
