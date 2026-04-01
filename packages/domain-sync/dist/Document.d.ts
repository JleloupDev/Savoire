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