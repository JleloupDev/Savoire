// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Rendu des icones de l'editeur. Les commandes ne donnent qu'un NOM d'icone
// (« bold », « table ») : l'hote fournit le dessin (apps/web : Lucide, via
// ui-components). Sans hote, le nom s'affiche en texte, comme avant.

import { createContext, useContext, type ReactNode } from 'react'

export type IconRenderer = (name: string, opts: { size: number }) => ReactNode

const textIcon: IconRenderer = (name, { size }) => (
  <span aria-hidden style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: size, height: size, fontSize: Math.round(size * 0.8), fontWeight: 600, lineHeight: 1 }}>
    {name}
  </span>
)

export const IconContext = createContext<IconRenderer>(textIcon)

export function EditorIcon({ name, size = 16 }: { name?: string | null; size?: number }) {
  const render = useContext(IconContext)
  if (!name) return null
  return <>{render(name, { size })}</>
}
