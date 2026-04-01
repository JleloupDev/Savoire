// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { DocumentStore, IDocumentMeta, IVaultStorage, VaultClient } from '@savoire/platform';
import type { VaultAPI } from '@savoire/plugin-api';
export interface AppVaultSummary {
    id: string;
    name: string;
    role: string;
    documentCount: number;
    folderCount: number;
    lastModifiedAt: string | null;
    sizeBytes: number;
}
export interface AppDocumentSummary {
    id: string;
    path: string;
}
export interface VaultHubLike {
    connect(): Promise<void>;
    dispose(): Promise<void>;
    createDocument(path: string): Promise<IDocumentMeta>;
    renameDocument(documentId: string, newPath: string): Promise<void>;
    deleteDocument(documentId: string): Promise<void>;
}
export interface VaultHubFactoryParams {
    vaultId: string;
    vaultClient: VaultClient;
    onChanged: () => void;
}
export interface IVaultHubFactory {
    create(params: VaultHubFactoryParams): VaultHubLike;
}
export interface IVaultsBackend {
    listVaults(userId: string, token: string): Promise<AppVaultSummary[]>;
    createVault(userId: string, name: string, token: string): Promise<AppVaultSummary>;
    renameVault(vaultId: string, name: string, token: string): Promise<AppVaultSummary>;
    deleteVault(vaultId: string, token: string): Promise<void>;
    listDocuments(vaultId: string, token: string): Promise<AppDocumentSummary[]>;
}
export interface IVaultsAPI {
    list(userId: string, token: string): Promise<AppVaultSummary[]>;
    create(userId: string, name: string, token: string): Promise<AppVaultSummary>;
    rename(vaultId: string, name: string, token: string): Promise<AppVaultSummary>;
    delete(vaultId: string, token: string): Promise<void>;
}
export interface ActivatedVault {
    readonly vaultId: string;
    readonly client: VaultClient;
    readonly hub: VaultHubLike;
    dispose(): Promise<void>;
}
export interface ActivateVaultParams {
    vaultId: string;
    token: string;
    storage: IVaultStorage;
    documentStore: DocumentStore;
    resolveDoc: (path: string) => IDocumentMeta | undefined;
    onChanged: () => void;
}
export interface IDocumentsAPI {
    activateVault(params: ActivateVaultParams): Promise<ActivatedVault>;
    getActiveClient(): VaultClient | undefined;
    list(vaultId: string, token: string): Promise<AppDocumentSummary[]>;
    disposeActiveVault(): Promise<void>;
}
export interface IDocumentSessionAPI {
    open(vaultId: string, docId: string, metadata: IDocumentMeta, token: string): Promise<string>;
    close(vaultId: string, docId: string): void;
    read(vaultId: string, docId: string, token: string): Promise<string>;
}
export interface IWorkspaceAPI {
    createVaultProxy(getClient: () => VaultClient | undefined, resolveDocId: (path: string) => string | undefined): VaultAPI;
}
export interface IApplicationAPI {
    vaults: IVaultsAPI;
    documents: IDocumentsAPI;
    documentSession: IDocumentSessionAPI;
    workspace: IWorkspaceAPI;
}
//# sourceMappingURL=contracts.d.ts.map