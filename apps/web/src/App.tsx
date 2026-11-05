// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { createWebServices } from './createWebAppRoot'
import { AuthProvider } from './AuthContext'
import { VaultKeyProvider } from './VaultKeyContext'
import { LoginPage } from './LoginPage'
import { AppShell } from './AppShell'
import { AdminPage } from './AdminPage'
import { ShareAccessPage } from './ShareAccessPage'
import { ViewGrantPage } from './ViewGrantPage'
import { ToastContainer } from './ToastContainer'
import { getServerChoice } from './serverConnection'
import { CALLBACK_PATH, loopbackLoginDriver, redirectLoginDriver, tauriLoopbackBridge } from './loginFlow'
import { isAndroidRuntime, isTauriRuntime } from './tauriRuntime'

const { authApi, adminApi, sharingApi, setTokenRenewer } = createWebServices()

// Bureau : navigateur du systeme et retour sur 127.0.0.1. Navigateur et
// Android (pas de port local a ecouter) : redirection dans la page.
const loginDriver = isTauriRuntime() && !isAndroidRuntime()
  ? loopbackLoginDriver(tauriLoopbackBridge())
  : redirectLoginDriver()

export function App() {
  return (
    // Version bureau (serveur au choix) : un seul compte a la fois.
    <AuthProvider authApi={authApi} loginDriver={loginDriver} singleAccount={getServerChoice().configurable} setTokenRenewer={setTokenRenewer}>
      <VaultKeyProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            {/* Retour du fournisseur d'identite : AuthProvider le traite. */}
            <Route path={CALLBACK_PATH} element={<LoginPage />} />
            <Route path="/admin" element={<AdminPage adminApi={adminApi} />} />
            <Route path="/share/:token" element={<ShareAccessPage sharingApi={sharingApi} />} />
            <Route path="/view" element={<ViewGrantPage />} />
            <Route path="/" element={<AppShell />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
        {/* Rendered once here, never inside a route/gate's conditionally-returned
            tree — a toast fired right as e.g. AppShell swaps to VaultKeyGate
            (WrongVaultKeyError) must survive that same-commit unmount, or it's
            never actually seen (see AppShell's switchToVault error handling). */}
        <ToastContainer />
      </VaultKeyProvider>
    </AuthProvider>
  )
}
