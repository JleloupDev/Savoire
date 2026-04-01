import type { ApplyResult, ICollabDocumentEngine } from '@poc/domain-sync';
export declare class YjsCollabDocumentEngine implements ICollabDocumentEngine {
    private readonly doc;
    private readonly text;
    constructor(initialText?: string);
    applyLocal(payload: Uint8Array): ApplyResult;
    applyRemote(payload: Uint8Array): ApplyResult;
    getText(): string;
}
//# sourceMappingURL=YjsCollabDocumentEngine.d.ts.map