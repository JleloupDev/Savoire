// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './dev.css'
import { DevPlayground } from './DevPlayground'
import { WorkspacePlayground } from './WorkspacePlayground'

function App() {
  const [mode, setMode] = useState<'editor' | 'workspace'>('editor')

  if (mode === 'workspace') {
    return <WorkspacePlayground onBack={() => setMode('editor')} />
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div
        style={{
          display: 'flex',
          gap: 4,
          padding: '4px 8px',
          background: '#f0efe9',
          borderBottom: '1px solid #dddcd5',
        }}
      >
        <span style={{ fontSize: 11, color: '#888', alignSelf: 'center', marginRight: 4 }}>Mode:</span>
        <button
          onClick={() => setMode('editor')}
          style={{
            fontSize: 11,
            padding: '1px 8px',
            background: '#1a1a18',
            color: '#fff',
            border: '1px solid #dddcd5',
            borderRadius: 3,
            cursor: 'pointer',
          }}
        >
          Editor
        </button>
        <button
          onClick={() => setMode('workspace')}
          style={{
            fontSize: 11,
            padding: '1px 8px',
            background: 'transparent',
            color: '#555',
            border: '1px solid #dddcd5',
            borderRadius: 3,
            cursor: 'pointer',
          }}
        >
          Workspace
        </button>
      </div>
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <DevPlayground />
      </div>
    </div>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('Root element not found')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
