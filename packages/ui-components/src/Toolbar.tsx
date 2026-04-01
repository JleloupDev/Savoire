// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { ReactNode } from 'react'

export interface ToolbarProps {
  children: ReactNode
  style?: React.CSSProperties
}

export function Toolbar({ children, style }: ToolbarProps) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '4px 8px',
        borderBottom: '1px solid #e0e0e0',
        ...style,
      }}
    >
      {children}
    </div>
  )
}
