// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { createRoot } from 'react-dom/client'
import './app.css'
import { App } from './App'
import { initProfile } from './profile'

const root = document.getElementById('root')
if (!root) throw new Error('Root element not found')

// StrictMode disabled: AppShell mounts twice for real in dev under it (not
// just the normal, harmless render-purity double-invoke — confirmed via
// instance-counter diagnostics), and the second mount's cleanup does not run
// before the first mount's async bootstrap chain finishes, so a mountedRef
// guard in WorkspaceRoot's onDockviewReady continuation was not sufficient
// to prevent the resulting duplicate Dockview/EditorCore/Awareness state.
// See project memory (project_p2p_sync_design.md) for the investigation.
// Le profil de synchronisation est resolu AVANT le premier rendu : une garde
// de cles installee apres coup laisserait l'UI mentir entre les deux.
// ?profile=edgesync pour le profil P2P, sinon profil serveur Savoire.
void initProfile().then(profile => {
  if (profile.error) console.warn('[profile]', profile.error)
  createRoot(root).render(<App />)
})
