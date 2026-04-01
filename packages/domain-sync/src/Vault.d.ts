// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { ConnectivityState, ReplicationMode } from './enums';
import type { DocumentId, DocumentMeta, VaultId } from './types';
import { Document } from './Document';
import { VaultSyncState } from './VaultSyncState';
export declare class Vault {
    readonly id: VaultId;
    name: string;
    replicationMode: ReplicationMode;
    connectivityState: ConnectivityState;
    readonly sync: VaultSyncState;
    readonly documents: Map<string, Document>;
    constructor(params: {
        id: VaultId;
        name: string;
        replicationMode?: ReplicationMode;
        connectivityState?: ConnectivityState;
        sync?: VaultSyncState;
        documents?: Document[];
    });
    addDocument(document: Document): void;
    removeDocument(documentId: DocumentId): void;
    getDocument(documentId: DocumentId): Document | undefined;
    listDocuments(): DocumentMeta[];
    rename(newName: string): void;
    markOnline(): void;
    markOffline(): void;
    markConnecting(): void;
    markInSync(at: Date): void;
    markSyncing(): void;
    markOutOfSync(reason: string): void;
    markConflict(reason: string): void;
    markError(reason: string): void;
}
//# sourceMappingURL=Vault.d.ts.map