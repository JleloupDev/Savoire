// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { DocumentId, DocumentMeta } from './types';
export declare class Document {
    readonly id: DocumentId;
    name: string;
    path: string;
    title: string;
    content: string;
    isDeleted: boolean;
    updatedAt: Date;
    constructor(params: {
        id: DocumentId;
        name: string;
        path: string;
        title?: string;
        content?: string;
        isDeleted?: boolean;
        updatedAt?: Date;
    });
    toMeta(): DocumentMeta;
    renameTo(newName: string): void;
    moveTo(newPath: string): void;
    setContent(content: string): void;
    markDeleted(): void;
    restore(): void;
}
//# sourceMappingURL=Document.d.ts.map