export interface BlockWidget {
    mount(container: HTMLElement): void;
    destroy(): void;
}
export interface BlockContext {
    editorView: unknown;
}
/** Describes an entry in the slash command palette for this block type. */
export interface BlockTrigger {
    id: string;
    label: string;
    description?: string;
    icon?: string;
    category?: string;
    insert: string | ((ctx: {
        query: string;
    }) => string);
}
export interface BlockSpec {
    type: string;
    detect?: RegExp | ((text: string) => boolean);
    serialize(data: unknown): string;
    deserialize(raw: string): unknown;
    createEditorWidget(data: unknown, ctx: BlockContext): BlockWidget;
    renderClient(data: unknown, ctx: BlockContext): HTMLElement;
    /** If defined, auto-registers slash command entries for this block. */
    trigger?: BlockTrigger | BlockTrigger[];
}
export interface BlockRegistry {
    register(spec: BlockSpec): void;
    unregister(type: string): void;
    detectBlock(text: string): {
        type: string;
        spec: BlockSpec;
    } | null;
    getAll(): BlockSpec[];
    /**
     * Returns only specs whose registering plugin is in `ids`, plus untagged built-ins.
     * null = no filtering (return all). Used by LivePreview to limit rendering per note scope.
     */
    getActive?(ids: Set<string> | null): BlockSpec[];
    /**
     * Like detectBlock but filtered by active scope ids.
     * null = no filtering (same as detectBlock). Used by LivePreview.
     */
    detectActive?(text: string, ids: Set<string> | null): {
        type: string;
        spec: BlockSpec;
    } | null;
}
//# sourceMappingURL=blocks.d.ts.map