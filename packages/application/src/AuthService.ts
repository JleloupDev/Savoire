// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { IAuthAPI, IAuthBackend, AppAuthResponse } from './contracts'

export class AuthService implements IAuthAPI {
  constructor(private readonly backend: IAuthBackend) {}

  login(email: string, password: string): Promise<AppAuthResponse> {
    return this.backend.login(email, password)
  }

  refresh(refreshToken: string): Promise<AppAuthResponse> {
    return this.backend.refresh(refreshToken)
  }

  logout(accessToken: string, refreshToken: string): Promise<void> {
    return this.backend.logout(accessToken, refreshToken)
  }

  changePassword(token: string, currentPassword: string, newPassword: string): Promise<void> {
    return this.backend.changePassword(token, currentPassword, newPassword)
  }
}
