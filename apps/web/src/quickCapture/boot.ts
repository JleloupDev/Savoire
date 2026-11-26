// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Premier script de la page, avant l'appli (index.html) : s'il s'agit d'une
// note rapide, son ecran s'affiche tout de suite, et l'appli se charge dessous.
//
// Une note rapide est demandee par :
//  - le widget Android (ou un nouvel appui quand l'appli tourne deja) : la
//    coquille Android le dit par window.SavoireAndroid.takeLaunchAction(),
//    et previent d'un nouvel appui par l'evenement `savoire-android-launch` ;
//  - l'adresse `/?capture` (raccourci, favori, ecran d'accueil du telephone).
import { captureScreen } from './captureScreen'

interface AndroidBridge { takeLaunchAction?(): string }

const QUICK_NOTE = 'quick-note'

function androidAction(): string {
  try {
    return (window as unknown as { SavoireAndroid?: AndroidBridge }).SavoireAndroid?.takeLaunchAction?.() ?? ''
  } catch {
    return ''
  }
}

function askedByUrl(): boolean {
  const url = new URL(window.location.href)
  if (!url.searchParams.has('capture')) return false
  // L'adresse redevient celle de l'appli : un rechargement ne rouvre pas l'ecran.
  url.searchParams.delete('capture')
  history.replaceState(history.state, '', url.pathname + url.search + url.hash)
  return true
}

function showIfAsked(): void {
  if (androidAction() === QUICK_NOTE || askedByUrl()) captureScreen().show()
}

showIfAsked()
window.addEventListener('savoire-android-launch', () => {
  if (androidAction() === QUICK_NOTE) captureScreen().show()
})
