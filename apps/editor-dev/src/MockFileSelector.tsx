// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { MockFileSet } from './mock/types'

interface Props {
  sets: MockFileSet[]
  activeId: string
  onSelect: (set: MockFileSet) => void
}

export function MockFileSelector({ sets, activeId, onSelect }: Props) {
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
      <span style={{ fontSize: 11, color: '#aaa9a0', marginRight: 4 }}>Scenario</span>
      {sets.map((s) => (
        <button
          key={s.id}
          onClick={() => onSelect(s)}
          style={{
            fontSize: 11,
            padding: '2px 8px',
            borderRadius: 4,
            border: s.id === activeId ? '1px solid #7c3aed' : '1px solid #dddcd5',
            background: s.id === activeId ? '#7c3aed' : '#f0efe9',
            color: s.id === activeId ? '#fff' : '#1a1a18',
            cursor: 'pointer',
          }}
        >
          {s.label}
        </button>
      ))}
    </div>
  )
}
