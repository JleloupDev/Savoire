// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { createRoot } from 'react-dom/client'
import { ViewApp, type ViewAppParams } from './ViewApp'
import './styles.css'

function parseParams(): { ok: true; value: ViewAppParams } | { ok: false; error: string } {
  const params = new URLSearchParams(window.location.search)
  const grant = params.get('grant') ?? ''
  const vaultId = params.get('vaultId') ?? ''
  const docId = params.get('docId') ?? ''
  const path = params.get('path') ?? ''
  const token = params.get('token') ?? ''
  const userId = params.get('userId') ?? undefined
  const readOnly = params.get('readOnly') === 'true'

  if (!grant && (!vaultId || !docId || !path || !token)) {
    return { ok: false, error: 'Paramètres manquants: grant ou (vaultId, docId, path, token).' }
  }

  return {
    ok: true,
    value: {
      grantToken: grant || undefined,
      vaultId: vaultId || undefined,
      docId: docId || undefined,
      path: path || undefined,
      token: token || undefined,
      userId,
      readOnly,
      serverUrl: '',
    },
  }
}

const root = document.getElementById('root')
if (!root) throw new Error('Root element not found')

const parsed = parseParams()
if (!parsed.ok) {
  createRoot(root).render(
    <div className="view-status view-status-error">{parsed.error}</div>,
  )
} else {
  createRoot(root).render(<ViewApp params={parsed.value} />)
}
