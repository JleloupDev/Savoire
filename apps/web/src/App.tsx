// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { HttpAdminBackend, HttpAuthBackend, HttpSharingBackend } from '@savoire/infrastructure-sync'
import { AdminService, AuthService, SharingService } from '@savoire/application'
import { AuthProvider } from './AuthContext'
import { LoginPage } from './LoginPage'
import { AppShell } from './AppShell'
import { AdminPage } from './AdminPage'
import { ShareAccessPage } from './ShareAccessPage'
import { ViewGrantPage } from './ViewGrantPage'

const adminApi = new AdminService(new HttpAdminBackend())
const authApi = new AuthService(new HttpAuthBackend())
const sharingApi = new SharingService(new HttpSharingBackend())

export function App() {
  return (
    <AuthProvider authApi={authApi}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/admin" element={<AdminPage adminApi={adminApi} />} />
          <Route path="/share/:token" element={<ShareAccessPage sharingApi={sharingApi} />} />
          <Route path="/view" element={<ViewGrantPage />} />
          <Route path="/" element={<AppShell />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}
