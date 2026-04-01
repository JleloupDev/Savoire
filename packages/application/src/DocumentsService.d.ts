// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { VaultClient, type DocumentStore, type IDocumentMeta, type IVaultStorage } from '@savoire/platform';
import type { ActivatedVault, AppDocumentSummary, IDocumentsAPI, IVaultsBackend } from './contracts';
import { SyncOrchestrator } from './SyncOrchestrator';
export declare class DocumentsService implements IDocumentsAPI {
    private readonly backend;
    private readonly sync;
    private active;
    constructor(backend: IVaultsBackend, sync: SyncOrchestrator);
    activateVault(params: {
        vaultId: string;
        token: string;
        storage: IVaultStorage;
        documentStore: DocumentStore;
        resolveDoc: (path: string) => IDocumentMeta | undefined;
        onChanged: () => void;
    }): Promise<ActivatedVault>;
    getActiveClient(): VaultClient | undefined;
    list(vaultId: string, token: string): Promise<AppDocumentSummary[]>;
    disposeActiveVault(): Promise<void>;
}
//# sourceMappingURL=DocumentsService.d.ts.map