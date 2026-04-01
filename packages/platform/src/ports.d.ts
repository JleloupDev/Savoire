// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
/**
 * Platform ports — interfaces définies par la couche platform.
 *
 *
 * IDocumentMeta est intentionnellement minimal : la platform ne connaît pas DocumentDto
 * (DTO spécifique à l'API REST). Toute app qui implémente `id` + `path` est compatible.
 */
/** Interface minimale requise par la platform — sous-ensemble de DocumentDto. */
export interface IDocumentMeta {
    id: string;
    path: string;
}
/** Port : chargement du contenu textuel d'un document depuis n'importe quelle source. */
export interface IDocumentFetcher {
    getDocumentContent(vaultId: string, docId: string, token: string): Promise<string>;
}
/** Port : lecture/écriture de fichiers dans un vault (attachments, notes). */
export interface IVaultStorage {
    readFile(vaultId: string, path: string, token: string): Promise<string>;
    writeFile(vaultId: string, path: string, content: string, token: string): Promise<void>;
    resolveFileUrl(vaultId: string, path: string): string;
    listDocuments(vaultId: string, token: string): Promise<IDocumentMeta[]>;
    createDocument(vaultId: string, path: string, token: string): Promise<IDocumentMeta>;
    renameDocument(vaultId: string, docId: string, path: string, token: string): Promise<void>;
    deleteDocument(vaultId: string, docId: string, token: string): Promise<void>;
    createFolder(vaultId: string, path: string, token: string): Promise<void>;
    deleteFolder(vaultId: string, path: string, token: string): Promise<void>;
}
//# sourceMappingURL=ports.d.ts.map