// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { createWebServices } from './createWebAppRoot'
import { AuthProvider } from './AuthContext'
import { VaultKeyProvider } from './VaultKeyContext'
import { LoginPage } from './LoginPage'
import { LandingPage } from './LandingPage'
import { LANDING_PATH } from './visitorEntry'
import { AppShell } from './AppShell'
import { AdminPage } from './AdminPage'
import { ShareAccessPage } from './ShareAccessPage'
import { ViewGrantPage } from './ViewGrantPage'
import { OAuthConsentPage } from './OAuthConsentPage'
import { loadModulePlugins, modulePluginRegistry } from './pluginStore'
import { pluginRegistry } from './pluginRegistry'
import { ToastContainer } from './ToastContainer'
import { FeedbackBubble } from './FeedbackBubble'
import { getServerChoice } from './serverConnection'
import { CALLBACK_PATH, loopbackLoginDriver, redirectLoginDriver, tauriLoopbackBridge } from './loginFlow'
import { isAndroidRuntime, isTauriRuntime } from './tauriRuntime'
import { IconContext, type IconRenderer } from '@savoire/editor-react'
import { Icon } from '@savoire/ui-components'

// Icones de l'editeur (barre, bulle, menu « / ») : Lucide.
const renderIcon: IconRenderer = (name, { size }) => <Icon name={name} size={size} />

const { authApi, adminApi, sharingApi, setTokenRenewer } = createWebServices()

// Bureau : navigateur du systeme et retour sur 127.0.0.1. Navigateur et
// Android (pas de port local a ecouter) : redirection dans la page.
const loginDriver = isTauriRuntime() && !isAndroidRuntime()
  ? loopbackLoginDriver(tauriLoopbackBridge())
  : redirectLoginDriver()

export function App() {
  return (
    <IconContext.Provider value={renderIcon}>
      {/* Version bureau (serveur au choix) : un seul compte a la fois. */}
      <AuthProvider authApi={authApi} loginDriver={loginDriver} singleAccount={getServerChoice().configurable} setTokenRenewer={setTokenRenewer}>
        <VaultKeyProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              {/* Page vitrine des visiteurs non connectes. */}
              <Route path={LANDING_PATH} element={<LandingPage />} />
              {/* Retour du fournisseur d'identite : AuthProvider le traite. */}
              <Route path={CALLBACK_PATH} element={<LoginPage />} />
              <Route path="/admin" element={<AdminPage adminApi={adminApi} />} />
              <Route path="/share/:token" element={<ShareAccessPage sharingApi={sharingApi} loadPlugins={loadModulePlugins} registry={{ ...pluginRegistry, ...modulePluginRegistry() }} />} />
              <Route path="/view" element={<ViewGrantPage />} />
              {/* Ecran d'accord OAuth du MCP (ChatGPT, Claude.ai). */}
              <Route path="/oauth/consent" element={<OAuthConsentPage />} />
              <Route path="/" element={<><AppShell /><FeedbackBubble /></>} />
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
    </IconContext.Provider>
  )
}
