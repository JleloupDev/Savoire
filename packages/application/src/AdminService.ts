// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { IAdminAPI, IAdminBackend, AppAdminUser } from './contracts'

export class AdminService implements IAdminAPI {
  constructor(private readonly backend: IAdminBackend) {}

  listUsers(token: string): Promise<AppAdminUser[]> {
    return this.backend.listUsers(token)
  }

  disableUser(token: string, userId: string): Promise<void> {
    return this.backend.disableUser(token, userId)
  }
}
