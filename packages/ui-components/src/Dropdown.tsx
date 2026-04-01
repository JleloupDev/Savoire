// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { useState, useRef, useEffect, type ReactNode } from 'react'

export interface DropdownItem {
  label: string
  onClick(): void
  disabled?: boolean
}

export interface DropdownProps {
  trigger: ReactNode
  items: DropdownItem[]
}

export function Dropdown({ trigger, items }: DropdownProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <div onClick={() => setOpen((v) => !v)}>{trigger}</div>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            background: '#fff',
            border: '1px solid #e0e0e0',
            borderRadius: 4,
            boxShadow: '0 4px 16px rgba(0,0,0,0.1)',
            zIndex: 100,
            minWidth: 160,
          }}
        >
          {items.map((item, i) => (
            <div
              key={i}
              onClick={() => {
                if (!item.disabled) {
                  item.onClick()
                  setOpen(false)
                }
              }}
              style={{
                padding: '6px 12px',
                cursor: item.disabled ? 'not-allowed' : 'pointer',
                opacity: item.disabled ? 0.5 : 1,
                fontSize: 13,
              }}
            >
              {item.label}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
