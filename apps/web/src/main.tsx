// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { createRoot } from 'react-dom/client'
import './app.css'
import { App } from './App'

const root = document.getElementById('root')
if (!root) throw new Error('Root element not found')

// StrictMode disabled: AppShell mounts twice for real in dev under it (not
// just the normal, harmless render-purity double-invoke — confirmed via
// instance-counter diagnostics), and the second mount's cleanup does not run
// before the first mount's async bootstrap chain finishes, so a mountedRef
// guard in WorkspaceRoot's onDockviewReady continuation was not sufficient
// to prevent the resulting duplicate Dockview/EditorCore/Awareness state.
// See project memory (project_p2p_sync_design.md) for the investigation.
createRoot(root).render(<App />)
