import type { IDocumentMeta, IVaultStorage } from '@poc/platform';
export interface RestVaultStorageOptions {
    baseUrl?: string;
    fetchFn?: typeof fetch;
}
export declare class RestVaultStorage implements IVaultStorage {
    private readonly baseUrl;
    private readonly fetchFn;
    constructor(options?: RestVaultStorageOptions);
    readFile(vaultId: string, path: string, token: string): Promise<string>;
    writeFile(vaultId: string, path: string, content: string, token: string): Promise<void>;
    resolveFileUrl(vaultId: string, path: string): string;
    listDocuments(vaultId: string, token: string): Promise<IDocumentMeta[]>;
    createDocument(vaultId: string, path: string, token: string): Promise<IDocumentMeta>;
    renameDocument(vaultId: string, docId: string, path: string, token: string): Promise<void>;
    deleteDocument(vaultId: string, docId: string, token: string): Promise<void>;
    createFolder(vaultId: string, path: string, token: string): Promise<void>;
    deleteFolder(vaultId: string, path: string, token: string): Promise<void>;
    private resolve;
}
//# sourceMappingURL=RestVaultStorage.d.ts.map