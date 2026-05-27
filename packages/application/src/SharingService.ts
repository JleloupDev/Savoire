// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type {
  ISharingAPI, ISharingBackend, SharedDocumentHandle,
  AppResourceSharing, AppResourcePermission, AppShareLink, AppShareLinkAccess, AppUserLookup,
} from './contracts'
import { CollabOrchestrator } from './CollabOrchestrator'

export class SharingService implements ISharingAPI {
  constructor(private readonly backend: ISharingBackend) {}

  getSharing(resourceType: 'vault' | 'document', id: string, token: string): Promise<AppResourceSharing> {
    return this.backend.getSharing(resourceType, id, token)
  }

  grantPermission(resourceType: 'vault' | 'document', id: string, subjectId: string, permission: string, token: string): Promise<AppResourcePermission> {
    return this.backend.grantPermission(resourceType, id, subjectId, permission, token)
  }

  revokePermission(resourceType: 'vault' | 'document', id: string, targetUserId: string, token: string): Promise<void> {
    return this.backend.revokePermission(resourceType, id, targetUserId, token)
  }

  lookupUserByEmail(email: string, token: string): Promise<AppUserLookup | null> {
    return this.backend.lookupUserByEmail(email, token)
  }

  createShareLink(resourceType: 'vault' | 'document', id: string, permission: string, token: string): Promise<AppShareLink> {
    return this.backend.createShareLink(resourceType, id, permission, token)
  }

  revokeShareLink(linkId: string, token: string): Promise<void> {
    return this.backend.revokeShareLink(linkId, token)
  }

  accessShareLink(shareToken: string): Promise<AppShareLinkAccess> {
    return this.backend.accessShareLink(shareToken)
  }

  async openSharedDocument(shareToken: string): Promise<SharedDocumentHandle> {
    const raw = await this.backend.openSharedDocument(shareToken)
    const orchestrator = new CollabOrchestrator(raw.crdt, raw.transport)
    return {
      ...raw,
      dispose() {
        orchestrator.dispose()
        raw.crdt.dispose()
        void raw.transport.disconnect()
      },
    }
  }
}
