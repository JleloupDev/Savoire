// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { IAdminAPI, IAdminBackend, AppAdminUser } from './contracts'

export class AdminService implements IAdminAPI {
  constructor(private readonly backend: IAdminBackend) {}

  listUsers(token: string): Promise<AppAdminUser[]> {
    return this.backend.listUsers(token)
  }

  createUser(token: string, email: string, password: string, displayName: string, isAdmin: boolean): Promise<void> {
    return this.backend.createUser(token, email, password, displayName, isAdmin)
  }

  resetPassword(token: string, userId: string, newPassword: string): Promise<void> {
    return this.backend.resetPassword(token, userId, newPassword)
  }

  revokeSessions(token: string, userId: string): Promise<void> {
    return this.backend.revokeSessions(token, userId)
  }

  disableUser(token: string, userId: string): Promise<void> {
    return this.backend.disableUser(token, userId)
  }
}
