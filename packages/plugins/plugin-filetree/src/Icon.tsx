// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Icones de l'hote (api.icons, Lucide) dans l'arbre des fichiers.
import { createContext, useContext, useLayoutEffect, useRef } from 'react'
import { createIcon, type IconAPI } from '@savoire/plugin-api'

export const IconsContext = createContext<IconAPI | undefined>(undefined)

export function Icon({ name, size = 15, style }: { name: string; size?: number; style?: React.CSSProperties }) {
  const icons = useContext(IconsContext)
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    ref.current?.replaceChildren(createIcon(icons, name, { size }))
  }, [icons, name, size])
  return <span ref={ref} aria-hidden style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, minWidth: size, height: size, ...style }} />
}
