// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Interface mobile ou interface bureau ? Choisi au demarrage.
//
// - Telephone (le petit cote de l'ecran fait moins de 600 px) : mobile, dans
//   les deux sens.
// - Tablette sans souris ni pave tactile, moins de 1024 px de large : mobile.
//   Avec un clavier a pave tactile (ou une souris), ou plus large : bureau.
// - La personne peut forcer l'un ou l'autre (`?layout=mobile`, `?layout=desktop`,
//   `?layout=auto` pour revenir au choix automatique) ; c'est retenu sur ce poste.

export type LayoutMode = 'mobile' | 'desktop'
export type LayoutOverride = LayoutMode | 'auto'

export interface ScreenInfo {
  width: number
  height: number
  /** Un pointeur precis existe (souris, pave tactile). */
  finePointer: boolean
}

const KEY = 'savoire-layout-mode'
const PHONE_SHORT_SIDE = 600
const TABLET_MAX_WIDTH = 1024

/** La regle, sans le navigateur. */
export function chooseLayout(screen: ScreenInfo, override: LayoutOverride = 'auto'): LayoutMode {
  if (override !== 'auto') return override
  if (Math.min(screen.width, screen.height) < PHONE_SHORT_SIDE) return 'mobile'
  if (!screen.finePointer && screen.width < TABLET_MAX_WIDTH) return 'mobile'
  return 'desktop'
}

function parseOverride(value: string | null | undefined): LayoutOverride | undefined {
  return value === 'mobile' || value === 'desktop' || value === 'auto' ? value : undefined
}

/** Le choix force sur ce poste (l'adresse d'abord, puis ce qui est retenu). */
export function layoutOverride(): LayoutOverride {
  try {
    const fromUrl = parseOverride(new URLSearchParams(window.location.search).get('layout'))
    if (fromUrl) {
      if (fromUrl === 'auto') localStorage.removeItem(KEY)
      else localStorage.setItem(KEY, fromUrl)
      return fromUrl
    }
    return parseOverride(localStorage.getItem(KEY)) ?? 'auto'
  } catch {
    return 'auto'
  }
}

export function setLayoutOverride(value: LayoutOverride): void {
  try {
    if (value === 'auto') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, value)
  } catch { /* stockage indisponible : le choix vaut pour cette fois */ }
}

let decided: LayoutMode | undefined

/** L'interface de cette session : decidee une fois, au premier appel. */
export function layoutMode(): LayoutMode {
  if (decided) return decided
  if (typeof window === 'undefined') return 'desktop'
  decided = chooseLayout({
    width: window.innerWidth,
    height: window.innerHeight,
    finePointer: window.matchMedia?.('(any-pointer: fine)').matches ?? true,
  }, layoutOverride())
  return decided
}
