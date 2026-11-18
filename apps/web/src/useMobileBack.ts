// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Sur mobile, le bouton retour du telephone ferme la fenetre ouverte
// (parametres, partage, ouverture rapide...) au lieu de changer d'ecran.

import { useEffect, useRef } from 'react'
import { registerMobileBack } from '@savoire/workspace'
import { layoutMode } from './layoutMode'

/** A appeler dans une fenetre : `close` la ferme. `open` : faux si elle reste montee fermee. */
export function useMobileBack(close: () => void, open = true): void {
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    if (!open || layoutMode() !== 'mobile') return
    return registerMobileBack(() => closeRef.current())
  }, [open])
}
