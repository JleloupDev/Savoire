// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { IAuthAPI, IAuthBackend, AppAuthConfig, AppAuthResponse, LoginPrompt, PendingLogin } from './contracts'

export class AuthService implements IAuthAPI {
  constructor(private readonly backend: IAuthBackend) {}

  config(): Promise<AppAuthConfig> {
    return this.backend.config()
  }

  beginLogin(redirectUri: string, prompt?: LoginPrompt): Promise<{ url: string; pending: PendingLogin }> {
    return this.backend.beginLogin(redirectUri, prompt)
  }

  completeLogin(pending: PendingLogin, callback: URLSearchParams): Promise<AppAuthResponse> {
    return this.backend.completeLogin(pending, callback)
  }

  refresh(refreshToken: string): Promise<AppAuthResponse> {
    return this.backend.refresh(refreshToken)
  }

  logout(accessToken: string, refreshToken: string): Promise<void> {
    return this.backend.logout(accessToken, refreshToken)
  }

  endSessionUrl(postLogoutRedirectUri: string, idTokenHint?: string): Promise<string | null> {
    return this.backend.endSessionUrl(postLogoutRedirectUri, idTokenHint)
  }
}
