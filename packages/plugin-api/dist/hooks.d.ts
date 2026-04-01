export type HookStage = 'beforeParse' | 'afterParse' | 'beforeRender' | 'afterRender' | 'onDocumentOpen' | 'onDocumentSave' | 'onSelectionChange';
export interface HookRegistry {
    beforeParse(hook: (source: string) => string | Promise<string>): void;
    afterParse(hook: (ast: unknown) => unknown | Promise<unknown>): void;
    beforeRender(hook: (ast: unknown) => unknown | Promise<unknown>): void;
    afterRender(hook: (html: string) => string | Promise<string>): void;
    onDocumentOpen(hook: (path: string) => void): void;
    onDocumentSave(hook: (path: string) => void): void;
    onSelectionChange(hook: (selection: unknown) => void): void;
    /**
     * Fired by editor-core after ~2s of inactivity on a document.
     * Used by ContentIndexingService to trigger local index updates.
     */
    onDocumentStabilized(hook: (docId: string, path: string, content: string) => void): void;
    runBeforeParse(source: string): Promise<string>;
    runBeforeParseSync(source: string): string;
    runAfterRender(html: string): Promise<string>;
    runDocumentOpen(path: string): void;
    runDocumentSave(content: string): void;
    runDocumentStabilized(docId: string, path: string, content: string): void;
}
//# sourceMappingURL=hooks.d.ts.map