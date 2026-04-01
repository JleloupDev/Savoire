// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { DocumentStore, IDocumentMeta } from '@savoire/platform';
import type { IDocumentSessionAPI } from './contracts';
export declare class DocumentSessionService implements IDocumentSessionAPI {
    private readonly store;
    constructor(store: DocumentStore);
    open(vaultId: string, docId: string, metadata: IDocumentMeta, token: string): Promise<string>;
    close(vaultId: string, docId: string): void;
    read(vaultId: string, docId: string, token: string): Promise<string>;
}
//# sourceMappingURL=DocumentSessionService.d.ts.map