// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { ButtonHTMLAttributes } from 'react'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'ghost' | 'primary'
  size?: 'sm' | 'md' | 'lg'
}

// ui-components must not depend on editor internals.
export function Button({ variant = 'default', size = 'md', style, ...props }: ButtonProps) {
  const sizeStyles: React.CSSProperties = {
    sm: { padding: '2px 8px', fontSize: 12 },
    md: { padding: '4px 12px', fontSize: 14 },
    lg: { padding: '8px 16px', fontSize: 16 },
  }[size]

  const variantStyles: React.CSSProperties = {
    default: { background: '#f0f0f0', border: '1px solid #ccc', color: '#333' },
    ghost: { background: 'transparent', border: 'none', color: 'inherit' },
    primary: { background: '#5865f2', border: 'none', color: '#fff' },
  }[variant]

  return (
    <button
      {...props}
      style={{
        cursor: 'pointer',
        borderRadius: 4,
        ...sizeStyles,
        ...variantStyles,
        ...style,
      }}
    />
  )
}
