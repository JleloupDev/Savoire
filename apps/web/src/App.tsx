// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './AuthContext'
import { LoginPage } from './LoginPage'
import { EditorPage } from './EditorPage'
import { AdminPage } from './AdminPage'
import { ShareAccessPage } from './ShareAccessPage'
import { ViewGrantPage } from './ViewGrantPage'

export function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="/share/:token" element={<ShareAccessPage />} />
          <Route path="/view" element={<ViewGrantPage />} />
          <Route path="/" element={<EditorPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}
