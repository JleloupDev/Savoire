// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { ReactNode } from 'react'

export interface PanelProps {
  title?: string
  children: ReactNode
  style?: React.CSSProperties
}

export function Panel({ title, children, style }: PanelProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        border: '1px solid #e0e0e0',
        borderRadius: 4,
        overflow: 'hidden',
        ...style,
      }}
    >
      {title && (
        <div
          style={{
            padding: '6px 12px',
            borderBottom: '1px solid #e0e0e0',
            fontWeight: 600,
            fontSize: 12,
            background: '#f8f8f8',
          }}
        >
          {title}
        </div>
      )}
      <div style={{ flex: 1, overflow: 'auto', padding: 8 }}>{children}</div>
    </div>
  )
}
